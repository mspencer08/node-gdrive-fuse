"use strict";
var google = require( 'googleapis' );
var fs = require( 'fs-extra' );
var winston = require( 'winston' );
var rest = require( 'restler' );
var pth = require( 'path' );
var fuse = require( 'fusejs' );
var os = require( 'os' );
var MD5 = require( 'MD5' );
var PosixError = fuse.PosixError;


var client = require('./client.es6.js');
var inodeTree = client.inodeTree;
var idToInode = client.idToInode;
var drive = client.drive;
var folder = require("./folder.es6.js");
var uploadTree = folder.uploadTree;
var GFolder = folder.GFolder;
var saveUploadTree = folder.saveUploadTree;
var f = require("./file.es6.js");
var logger = f.logger;
var GFile = f.GFile;
var addNewFile = f.addNewFile;
var queue_fn = f.queue_fn;
var queue = require('queue');

var exec = require('child_process').exec;

// read input config
var config = {};
if (fs.existsSync ('config.json') ){
    config = fs.readJSONSync('config.json')
}
if( !config.cacheLocation)
    config.cacheLocation =  "/tmp/cache";
if( !config.refreshDelay)
    config.refreshDelay = 60000;
if (!config.mountPoint)
    config.mountPoint = "/tmp/mnt";

var uploadLocation = pth.join(config.cacheLocation, 'upload')
var q = queue({concurrency: config.maxConcurrentUploads || 4, timeout: 7200000 }) // default to 4 concurrent uploads


// http://lxr.free-electrons.com/source/include/uapi/asm-generic/errno-base.h#L23
var errnoMap = {
    EPERM: 1,
    ENOENT: 2,
    EIO: 5,
    ENXIO: 9,
    EACCESS: 13,
    EEXIST: 17,
    ENOTDIR: 20,
    EISDIR: 21,
    EINVAL: 22,
    ESPIPE: 29,
    ENOTEMPTY: 39
};

/*
 ################################################
 ####### Filesystem Handler Functions ###########
 ################################################
 */
class GDriveFS extends fuse.FileSystem{

    getattr(context, inode, reply){
        if (inodeTree.has(inode)){
            inodeTree.get(inode).getAttr(
                function getAttrCallback(status, attr){
                    reply.attr(attr, 5)
                }
            );

        }else{
            reply.err(errnoMap.ENOENT)
        }
    }

    opendir(context, inode, fileInfo, reply){
        reply.open(fileInfo);
    }

    releasedir(context, inode, fileInfo, reply){
        console.log('Releasedir was called!');
        console.log(fileInfo);
        reply.err(0);
    }

    /*
     * Handler for the readdir() system call.
     * path: the path to the file
     * cb: a callback of the form cb(err, names), where err is the Posix return code
     *     and names is the result in the form of an array of file names (when err === 0).
     */
    readdir(context, inode, requestedSize, offset, fileInfo, reply){
        if(inodeTree.has(inode)){
            var object = inodeTree.get(inode);
            if(object instanceof GFile){
                reply.err( errnoMap.ENOTDIR)
            }else if (object instanceof GFolder){
                var size = Math.max( requestedSize , object.children.length * 256);
                // size = requestedSize
                var parent = inodeTree.get(object.parentid);
                var totalSize = 0;
                // totalSize += reply.addDirEntry('.', requestedSize, {inode: object.inode}, offset);
                // totalSize += reply.addDirEntry('..', requestedSize, {inode: parent.inode}, offset);
                for( let child of object.children ){
                    var cnode = inodeTree.get(child);
                    if(cnode){
                        var attr = cnode.getAttrSync();
                        //console.log( cnode.name, cnode.inode);
                        var len = reply.addDirEntry(cnode.name, size, {inode: cnode.inode}, offset);
                        totalSize += len
                    }
                }

                if( object.children.length == 0){
                    reply.buffer(new Buffer(0), 0);
                }else{
                    reply.buffer(new Buffer(0), requestedSize);
                }
            }else{
                reply.err(errnoMap.ENOENT)
            }
        }else{
            reply.err(errnoMap.ENOENT)
        }
    }

    setattr(context, inode, attrs, reply){
        logger.debug( `setting attr for ${inode}`);
        logger.silly(attrs);
        var file = inodeTree.get(inode);
        if(!file){
            reply.err(errnoMap.ENOENT);
            return;
        }
        // console.log file
        // console.log attrs
        var a = new Date(attrs.atime);
        var m = new Date(attrs.mtime);
        // console.log a.getTime(),m.getTime()
        // attrs.atime = a.getTime()
        // attrs.mtime = m.getTime()
        file.mtime = m.getTime()
        if (attrs.hasOwnProperty("size")){
            file.size = attrs.size
        }

        if (attrs.hasOwnProperty("mode")){
            logger.debug(`mode before and after: ${file.mode}-${attrs.mode}`)
            file.mode = attrs.mode
        }

        inodeTree.set( inode, file );


        reply.attr(file.getAttrSync(), 5);
        // reply.err(0)
    }

    open(context, inode, fileInfo, reply){
        var self = this;
        var flags = fileInfo.flags;
        if (flags.rdonly){ //read only
            if (inodeTree.has(inode)){
                var file = inodeTree.get(inode);
                if (file instanceof GFile){
                    if (file.downloadUrl){ //make sure that the file has been fully uploaded
                        reply.open(fileInfo);
                    }else{
                        //wait for filesystem to finish uploading file and retry again
                        reply.err(PosixError.EACCES);
                    }
                    return;
                }else{
                    reply(errerrnoMap.EISDIR);
                    return;
                }
            }else{
                reply.err( errnoMap.ENOENT );
            }
            return;
        }

        if( flags.wronly ){ //write only
            logger.silly(`$tried to open file "${inode}" for writing`);
            if ( inodeTree.has(inode) ){ //if folderTree has path, make sure it's a file with size zero
                var file = inodeTree.get(inode);
                if (file instanceof GFile){
                    if (file.size == 0){
                        // logger.debug(`${path} size was 0`);
                        if (uploadTree.has(inode)){
                            var cache = uploadTree.get(inode).cache;
                            fs.open( pth.join(uploadLocation, cache), 'w+', function openFileForWritingCallback(err,fd){
                                if (err){
                                    logger.debug( "could not open file for writing" );
                                    logger.debug( err );
                                    reply.err( errnoMap[err.code] );
                                    return;
                                }

                                fileInfo.fh = fd;
                                reply.open(fileInfo);
                            });
                        }else{
                            reply.err( errnoMap.EACCESS);
                        }

                    }else{
                        reply.err(errnoMap.EACCESS);
                    }
                }else{
                    reply.err(errnoMap.EISDIR);
                }
            }else{
                reply.err( errnoMap.ENOENT);
            }
            return
        }
        /*
         if (flags.rdwr){ // if it doesn't have the path, create the file
         reply.err(errnoMap.ENOENT);
         return;

         var parent = folderTree.get( pth.dirname(path) );
         if ( parent && parent instanceof GFolder){
         var now = ( new Date()).getTime();
         var name = pth.basename(path)

         var file = new GFile(null, null, parent.id, name, 0, now, now, true)
         folderTree.set( path, file );
         var upFile = {
         cache: cache,
         uploading: false
         };
         uploadTree.set(  path, upFile );
         saveUploadTree();

         if (parent.children.indexOf(name) < 0);
         (parent.children.push name);

         fs.open pth.join(uploadLocation, cache), 'w', (err,fd) ->
         if err
         cb -errnoMap[err.code]
         else
         cb 0, fd
         return

         return
         else
         cb -errnoMap.EPERM
         return

         cb(-errnoMap.ENOENT)
         return
         */

        if (flags.rdwr){ //read/write
            logger.debug( `tried to open file "${path}" for r+w`);
            reply.err( errnoMap.ENOENT );
        }

        return;
    }

    read(context, inode, len, offset, fileInfo, reply){
        // logger.silly( `reading file ${path} - ${offset}:${len}`);
        var once = false
        function readDataCallback(dataBuf){
            if(!once){
                once = true;
                reply.buffer(dataBuf, dataBuf.length);
            }
        }

        if( inodeTree.has(inode)){
            // make sure that we are only reading a file
            var file = inodeTree.get(inode)
            if (file instanceof GFile ){

                // make sure the offset request is not bigger than the file itself
                if (offset < file.size){
                    file.read(offset, offset+len-1,true,readDataCallback);
                }else{
                    reply.err(errnoMap.ESPIPE);
                }
            }else{
                reply.err(errnoMap.EISDIR)
            }

        }else{
            reply.err(errnoMap.ENOENT)
        }
    }

    write(context, inode, buffer, position, fileInfo, reply){

        // path = inodeToPath.get inode
        // logger.silly( `writing to file ${path} - position: ${position}, length: ${buffer.length}"

        var file = inodeTree.get( inode )
        if (!file){
            logger.debug( inode );
            reply.err( errnoMap.ENOENT );
            return;
        }
        var size = file.size
        fs.write( fileInfo.fh, buffer, 0, buffer.length, position, function fsWriteCallback(err, bytesWritten, buffer){
            if (err){
                logger.debug( `there was an error writing for file ${file.name}` )
                logger.debug( err )
                logger.debug( "position", position, "fh", fileInfo.fh )
                reply.err(err.errno);
                return;
            }

            // it is simportant to update the file size as we copy in to it. sometimes, cp and mv will check the progress by scanning the filesystem
            if ( size < (position + buffer.length) ){
                file.size = position + buffer.length
            }
            reply.write(bytesWritten);
        });
    }

    flush(context, inode, fileInfo, reply){
        reply.err(0);
    }

    /*
     * Handler for the mkdir() system call.
     * path: the path of the new directory
     * mode: the desired permissions of the new directory
     * cb: a callback of the form cb(err), where err is the Posix return code.
     */
    mkdir(context, parentInode, name, mode, reply){
        // parentPath = inodeToPath.get parentInode
        // path = pth.join parentPath, name
        // logger.debug(`creating folder ${path}");
        logger.debug( `creating folder ${name}` );
        var parent = inodeTree.get( parentInode);
        if( parent ){ //make sure that the parent exists
            if (parent instanceof GFolder){ //make sure that the parent is a folder

                for( let childInode of parent.children){ // make sure that the child doesn't already exist
                    var child = inodeTree.get(childInode)
                    if (child && child.name === name ){
                        reply.err(errnoMap.EEXIST);
                        return;
                    }
                }

                var folder = {
                    resource:{
                        title: name,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [{id: parent.id}]
                    }
                };

                drive.files.insert(folder, function createFolderCallback(err, res){
                    if (err){
                        logger.log( "error", err );
                        reply.err(errnoMap.EIO);
                        return;
                    }else{
                        var now = (new Date).getTime()

                        var inodes = [];
                        for ( let value of inodeTree.values() ){
                            inodes.push(value.inode);
                        }    
                        var inode = Math.max( Math.max.apply(null,inodes) + 1,2);
                        parent.children.push( inode );
                        var folder = new GFolder(res.id, res.parents[0].id, name, (new Date(res.createdDate)).getTime(), (new Date(res.modifiedDate)).getTime(), inode, res.editable, [])
                        inodeTree.set( inode, folder );
                        idToInode.set( folder.id, inode );
                        var attr = folder.getAttrSync();
                        let entry = {
                            inode: attr.inode,
                            generation: 2,
                            attr: attr,
                            attr_timeout: 5,
                            entry_timeout: 5
                        };
                        reply.entry(entry);
                        client.saveFolderTree();
                    }
                });
            }else{
                reply.err(errnoMap.ENOTDIR)
            }
        }else{
            reply.err(errnoMap.ENOENT)
        }
    }

    /*
     * Handler for the rmdir() system call.
     * path: the path of the directory to remove
     * cb: a callback of the form cb(err), where err is the Posix return code.
     */
    rmdir(context, parentInode, name, reply) {
        var parent = inodeTree.get(parentInode);
        logger.debug( `removing
      folder
      ${name}
      ` )
        ;

        // make sure the actual directory exists
        for (childInode of parent.children) {
            var folder = inodeTree.get(childInode);
            if (folder.name === name) {

                //make sure that it is a folder
                if (folder instanceof GFolder) {
                    //make sure it is empty
                    if (folder.children.length == 0) {
                        drive.files.trash({fileId: folder.id}, function removeDirCallback(err, res) {
                            if (err) {
                                logger.error( `unable to remove folder ${path}`);
                                reply.err(errnoMap.EIO);
                                return;
                            }
                            var idx = parent.children.indexOf(childInode);
                            if (idx >= 0) {
                                parent.children.splice(idx, 1);
                            }
                            inodeTree.delete(childInode)
                            idToInode.delete(folder.id);

                            reply.err(0)
                            client.saveFolderTree();
                        });
                        return;
                    } else {
                        reply.err(errnoMap.ENOTEMPTY);
                        return;
                    }
                } else {
                    reply.err(errnoMap.ENOTDIR);
                    return;
                }
            }
        }

        reply.err(errnoMap.ENOENT);
    }

    mknod(context, parentInode, name, mode, rdev, reply){

        var parent = inodeTree.get(parentInode);

        for(childInode in parent.children){ //TODO: if file exists, delete it first
            var child = inodeTree.get(childInode);
            if (child && child.name === name){
                reply.err(PosixError.EEXIST);
                return;
            }
        }

        var now = (new Date).getTime();
        var inodes = [];
        for ( let value of inodeTree.values() ){
            inodes.push(value.inode);
        }    
        var inode = Math.max( Math.max.apply(null,inodes) + 1,2);

        var file = new GFile(null, null, parent.id, name, 0, now, now, inode, true)
        inodeTree.set( inode, file );
        parent.children.push(inode);

        logger.debug (`mknod: parentid: ${parent.id} -- inode ${inode}` );
        logger.info  (`adding a new file ${name} to folder ${parent.name}` );
        var attr = file.getAttrSync();

        var upFile ={
            cache: MD5(parent.id + name),
            uploading: false
        }
        uploadTree.set( inode, upFile);
        saveUploadTree();


        entry = {
            inode: attr.inode,
            generation: 2,
            attr: attr
            //attr_timeout: 30,
            //entry_timeout: 60
        };

        reply.entry(entry);
        return;
    }
    


    create(context, parentInode, name, mode, fileInfo, reply){
        var parent = inodeTree.get (parentInode);

        if (parent){ //make sure parent exists
            logger.debug( `creating file ${name}`);

            var cache = MD5(parent.id + name);
            var systemPath = pth.join(uploadLocation, cache);

            //for childInode in parent.children #TODO: if file exists, delete it first
            //  parent.children.push name
            var now = (new Date).getTime();
            logger.debug( `adding file "${name}" to folder "${parent.name}"`);
            var now = (new Date).getTime()

            var inodes = [];
            for ( let value of inodeTree.values() ){
                inodes.push(value.inode);
            }    
            var inode = Math.max( Math.max.apply(null,inodes) + 1,2);
            var file = new GFile(null, null, parent.id, name, 0, now, now, inode, true);
            inodeTree.set(inode, file)
            parent.children.push(inode);

            logger.debug( `create: parentid: ${parent.id} -- inode ${inode}`);
            logger.info (`adding a new file ${name} to folder ${parent.name}`);

            client.saveFolderTree();

            fs.open( systemPath, 'w', function createOpenFileCallback(err, fd){
                if (err){
                    logger.error( `unable to create file ${inode} -- ${name}, ${err}` );
                    reply.err(errnoMap[err.code]);
                    return;
                }
                fileInfo.fh = fd;
                logger.debug( "setting upload Tree" );
                var upFile = {
                    cache: cache,
                    uploading: false
                };
                uploadTree.set( inode, upFile );
                saveUploadTree()
                var attr = {
                    inode: inode, //#parent.inode,
                    generation: 1,
                    attr:file
                };
                reply.create( attr, fileInfo );
                return;
            });
        }else{
            reply.err( errnoMap.ENOENT );
        };
    }
    /*
     * Handler for the unlink() system call.
     * path: the path to the file
     * cb: a callback of the form cb(err), where err is the Posix return code.
     */
    unlink(context, parentInode, name, reply){
        logger.debug( `removing file ${name}`);
        var parent = inodeTree.get( parentInode );

        for( let childInode of parent.children ){
            var file = inodeTree.get(childInode)

            // make sure the file still exists in the inodeTree
            // if not, remove it
            if(file){
                var idx = parent.children.indexOf(childInode);
                parent.children.splice(idx,1);
                continue;
            }

            // make sure it's the right file
            if(file.name != name){
                continue;
            }

            if(file instanceof GFolder){
                reply.err (errnoMap.EISDIR);
                return;
            }

            parent.children.splice( parent.children.indexOf(childInode), 1)
            inodeTree.delete( childInode );
            idToInode.delete( file.id );
            client.saveFolderTree();

            drive.files.trash( {fileId: file.id}, function deleteFileCallback(err, res){
                if (err){
                    logger.debug( `unable to remove file ${file.name}` );
                }
                reply.err(0) //TODO: handle case when google fails to delete a file
            });

            if (uploadTree.has( childInode )){
                var cache = uploadTree.get(childInode).cache;
                uploadTree.delete(childInode)
                fs.unlink(pth.join(uploadLocation,cache), function unlinkDeleteFileCallback(err){});
            }

            return;
        }

        reply.err(PosixError.ENOENT);
    }


    /*
     * Handler for the release() system call.
     * path: the path to the file
     * fd:  the optional file handle originally returned by open(), or 0 if it wasn't
     * cb: a callback of the form cb(err), where err is the Posix return code.
     */
    release(context, inode, fileInfo, reply){
        logger.silly(`closing file ${inode}`)
        if (uploadTree.has (inode) ){
            logger.debug(`${inode} was in the upload tree`);
            // close the file
            fs.close( fileInfo.fh, function closeFileCallback(err){
                if (err){
                    reply.err(err.errno);
                    return;
                }
                reply.err(0);

                // upload file once file is closed
                if(uploadTree.has(inode)){
                    var upCache = uploadTree.get(inode);
                    upCache.released = true;
                    uploadTree.set(inode, upCache);
                    saveUploadTree();

                    var file = inodeTree.get(inode);
                    var parentInode = idToInode.get(file.parentid);
                    var parent = inodeTree.get(parentInode);
                    /*
                     three cases:
                     if file size is 0: delete it and don't upload
                     if file size is <=10MB, just upload it directly
                     if file size is >10 MB, add to upload queue
                     */


                    if( 0 < file.size &&  file.size <= 10485760){ //10MB
                        parent.upload( file.name, inode, uploadCallback(inode, function(){})    );
                    }else if(file.size >  10485760 ){}
                    q.push(
                        function uploadQueueFunction(cb){
                            if( parent instanceof GFile){
                                logger.debug(`While uploading, ${name} was a file - ${parent}`);
                                cb();
                                return;
                            }
                            parent.upload(file.name, inode, uploadCallback(inode,cb))
                            return
                        }
                    );

                    q.start()
                }else{
                    uploadTree.delete(inode);
                    saveUploadTree();
                }
            });
        }else if (fileInfo.fh){
            fs.close(fileInfo.fh, function closeFileCallback(err){
                if (err){
                    logger.error("There was an error closing file");
                    logger.error(err);
                    reply.err(err.errno);
                    return;
                }
                reply.err(0);
            });
        }else{
            reply.err(0);
        }
    }

    statfs(context, inode, reply){
        reply.statfs( {
            bsize: Math.floor(config.chunkSize/2),
            iosize: Math.floor(config.chunkSize/2),
            frsize: Math.floor(config.chunkSize/2),
            blocks: 1000000,
            bfree: 1000000,
            bavail: 1000000,
            files: 1000000,
            ffree: 1000000,
            favail: 1000000,
            fsid: 1000000,
            flag: 0
        });
    }

    getxattr(context, parentInode, name, size, position, reply){
        console.log('GetXAttr was called!');
        var parent = inodeToPath.get(parentInode)
        for( childInode of parent.children){
            if(inodeTree.get(childInode).name === name){
                reply.err(0);
                return;
            }
        }
        reply.err( PosixError.ENOENT);
    }

    listxattr(context, inode, size, reply){
        console.log("listxattr called");
        var obj = inodeTree.get(inode);
        if (obj){
            // console.log(obj);
        }

        reply.xattr( 1024*1024 );
    }

    access(context, inode, mask, reply){
        console.log('Access was called!');
        reply.err(0);
        return;
    }

    rename(context, oldParentInode, oldName, newParentInode, newName, reply){
        //find the currrent child
        var parent = inodeTree.get(oldParentInode);
        if(!parent){
            reply.err(PosixError.ENOENT);
            return;
        }

        for( childInode of parent.children){
            var child = inodeTree.get(childInode);
            if (child.name === oldName){
                // move to new folder if required
                var params = {
                    resource:{
                        title: newName
                    },
                    fileId: child.id,
                    modifiedDate: true
                };
                if( newParentInode != oldParentInode ){
                    var newParent = inodeTree.get(newParentInode);
                    var oldParent = parent;
                    if( !newParent ){
                        reply.err (PosixError.ENOENT);
                        return;
                    }
                    if(  !(newParent instanceof GFolder)){
                        reply.err (PosixError.ENOTDIR);
                        return;
                    }
                    params.addParents = newParentInode.id;
                    params.removeParents =  parent.id;
                }

                child.name = newName;
                console.log ("before google api");
                drive.files.patch( params, function filesPatchCallback(err){
                    console.log("after google api");
                    if (err){
                        logger.error( `There was an error with renaming file ${child.name}` );
                        logger.error( err );
                        reply.err (PosixError.EIO);
                        return
                    }
                    reply.err(0);
                    if (newParentInode != oldParentInode){
                        newParent.children.push (childInode);
                        oldParent.children.splice( oldParent.children.indexOf(childInode), 1 );
                    }
                });
                return
            }
        }

        // if we get here, it means there was no child found
        reply.err( PosixError.ENOENT)
    }

    lookup(context, parentInode, name, reply){

        //make sure the parent inode exists
        if( !inodeTree.has(parentInode)){
            reply.err(PosixError.ENOENT);
        }

        var parent = inodeTree.get( parentInode );
        for( let childInode of parent.children){
            var child = inodeTree.get(childInode);
            if (child && child.name === name){
                var attr = child.getAttrSync();
                attr.size = attr.size || 4096
                var entry = {
                    inode: childInode,
                    generation: 2,
                    attr: attr
                    // attr_timeout: 5,
                    // entry_timeout: 5
                };
                reply.entry(entry);
                return;
            }
        }

        //if the child is not found
        reply.err(PosixError.ENOENT);

    }
}


function moveToDownload (file, fd, uploadedFileLocation, start,cb){

    var end = Math.min(start + config.chunkSize, file.size)-1
    var savePath = pth.join(config.cacheLocation, 'download', `${file.id}-${start}-${end}`);
    var rstream = fs.createReadStream(uploadedFileLocation, {fd: fd, autoClose: false, start: start, end: end})
    var wstream = fs.createWriteStream(savePath)

    rstream.on('end',  function moveToDownloadReadStream(){

        start += config.chunkSize;
        wstream.end();
        if (start < file.size){
            moveToDownload(file, fd, uploadedFileLocation, start, cb);
            return;
        }
        fs.close( fd, function moveToDownloadFinishCopying(err){
            if(err){
                logger.error( `There was an error closing file ${fd} - ${file.id} - ${file.name} after moving upload file to download` );
                logger.error( err );
            }
            var start = 0
            var end = Math.min(start + config.chunkSize, file.size)-1
            var totalSize = 0
            var count = 0
            var basecmd = "INSERT OR REPLACE INTO files (name, atime, type, size) VALUES "
            var cmd = basecmd
            while(start < file.size){
                var size = end - start + 1
                count += 1
                totalSize += size
                if(count > 750){
                    cmd += `('${file.id}-${start}-${end}',${Date.now()},'downloading',${size})`
                    queue_fn(totalSize, cmd)(function(){});
                    cmd = basecmd;
                    count = 0;
                    totalSize = 0;
                }else{
                    cmd += `('${file.id}-${start}-${end}',${Date.now()},'downloading',${size}),`
                }
                start += config.chunkSize;
                end = Math.min(start + config.chunkSize, file.size)-1
            }
            queue_fn(totalSize,cmd.slice(0,-1))(function(){});
            if (err){
                logger.debug(`unable to close file after transffering ${uploadedFile}`);
                cb();
                return;
            }
            fs.unlink( uploadedFileLocation, function deleteUploadedFile(err){
                if (err){
                    logger.error( `unable to remove file ${uploadedFile}`)
                }
                cb();
            });
        });
    });

    rstream.pipe(wstream);
}

//function to create a callback for file uploading
function uploadCallback(inode, cb){

    return function (err, result){
        var file = inodeTree.get(inode)
        var parentInode = idToInode.get(file.parentid)
        var parent = inodeTree.get(parentInode)
        if(err){
            if (err === "invalid mime"){
                logger.debug(`the mimetype of ${path} was invalid`);
                cb();
                return
            }
            if(err === "uploading"){
                cb();
                return;
            }
            if(err.code === "ENOENT"){
                uploadTree.delete(inode);
                cb();
                return;
            }


            cb();
            logger.debug(`Retrying upload: "${file.name}".`);
            q.push(
                function uploadFunctionQueued(_cb){
                    parent.upload(file.name, inode , uploadCallback(inode,_cb));
                    return;
                }
            );
            q.start()
        }

        var upFile = uploadTree.get(inode)

        if(!upFile){ //#make sure uploaded file is still in the uploadTree
            cb();
            return;
        }
        var uploadedFileLocation = pth.join( uploadLocation, upFile.cache);

        logger.info( `successfully uploaded ${file.name}`);

        uploadTree.delete(inode);
        saveUploadTree();
        if (inodeTree.has(inode)){
            logger.debug(`${file.name} already existed in inodeTree`);
            var file = inodeTree.get(inode);
            file.downloadUrl = result.downloadUrl
            file.id = result.id
            file.size = parseInt(result.fileSize)
            file.ctime = (new Date(result.createdDate)).getTime()
            file.mtime =  (new Date(result.modifiedDate)).getTime()
        }else{
            logger.debug(`${file.name} folderTree did not exist`);
            var inodes = [];
            for ( let value of inodeTree.values() ){
                inodes.push(value.inode);
            }    
            let inode = Math.max( Math.max.apply(null,inodes) + 1,2);
            var file = new GFile(result.downloadUrl, result.id, result.parents[0].id, result.title, parseInt(result.fileSize), (new Date(result.createdDate)).getTime(), (new Date(result.modifiedDate)).getTime(), inode, true)
        }
        // update parent
        if( !(file.inode in parent.children)){
            parent.children.push(file.inode)
        }
        inodeTree.set( file.inode, file );
        idToInode.set( file.id, file.inode );
        client.saveFolderTree();

        // move the file to download folder after finished uploading
        fs.open( uploadedFileLocation, 'r', function openFileAfterUploadCallback(err,fd){
            if(err){
                logger.debug( `could not open ${uploadedFileLocation} for copying file from upload to uploader` );
                logger.debug( err );
                return;
            }

            moveToDownload(file, fd, uploadedFileLocation, 0, cb)
        });

    };
}

// resume file uploading
function resumeUpload(){
    // uploadWork = null
    if (uploadTree.size > 0){
        logger.info( "resuming file uploading" );
        for(let inode of uploadTree.keys()){
            if( inodeTree.has(inode) )
                var file = inodeTree.get(inode);
            else{
                uploadTree.delete(inode);
                return;
            }

            // check to see if the file was released by the filesystem
            // if it wasn't released by the filesystem, it means that the file was not finished transfering
            if (value.released){
                var parentInode = idToInode.get( file.parentid )
                value.uploading = false
                if (inodeTree.has(parentInode)){
                    var parent = inodeTree.get(parentInode)
                    if (parent instanceof GFolder){
                        inodeTree.set(key, value);
                        q.push(
                            function resumeUploadQueueFunction(cb){
                                parent.upload(file.name, inode, uploadCallback(inode,cb));
                            }
                        )
                        q.start();
                        return;
                    }else{
                        logger.debug(`While resuming uploads, ${parent} was not a folder`);
                    }
                }
            }else{
                inodeTree.delete(inode)
                uploadTree.delete(inode)
                parentInode = idToInode.get(value.parentid);
                parent = inodeTree.get(parentInode)
                if (parent){
                    var idx = parent.children.indexOf(inode)
                    if (idx > 0){
                        parent.children.splice(idx, 1)
                    }
                }
                var path = pth.join(uploadLocation, value.cache)
                fs.unlink(path, function(){});
            }
        };
    }

}

function start(count){
    if( inodeTree.size > 1){
        try{
            logger.info('attempting to start f4js');
            var add_opts;
            var command;
            switch (os.type()){
                case 'Linux':
                    add_opts = ["-o", "allow_other", ]
                    command = `umount -f ${config.mountPoint}`
                    break;
                case 'Darwin':
                    add_opts = ["-o",'daemon_timeout=0', "-o", "noappledouble", "-o", "noubc"];
                    command = `diskutil umount force ${config.mountPoint}`
                    break
                default:
                    add_opts = []
                    command = `fusermount -u ${config.mountPoint}`
            }
            if( process.version < '0.11.0'){
                opts.push( "-o", "allow_other")
            }

            var debug = false;

            exec( command, function unmountCallback(err, data){
                fs.ensureDirSync(config.mountPoint);
                if (err){
                    logger.error( "unmount error:", err);
                }
                if (data){
                    logger.info( "unmounting output:", data);
                }
                var opts =  ["GDrive", "-o",  "allow_other", config.mountPoint];
                // opts.push "-s"
                // opts.push "-f"

                // opts.push "-mt"
                // opts.push "-d"
                fuse.fuse.mount({
                    filesystem: GDriveFS,
                    options: opts.concat(add_opts)
                });

                logger.log('info', `mount point: ${config.mountPoint}`);
                setTimeout(resumeUpload, 8000);
                return;
            });
        }catch(e){
            logger.log( "error", `Exception when starting file system: ${e}`);
        }
    }else{
        setTimeout(start, 500);
    }
}


start(0)
