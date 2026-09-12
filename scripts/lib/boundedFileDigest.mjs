import {openSync,readSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
// Model files exceed Node's single-buffer limit. Keep peak hashing memory bounded.
export function boundedFileDigest(path){
 const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(1024*1024),hash=createHash('sha256');
 try {for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;hash.update(buffer.subarray(0,count));}return hash.digest('hex');}
 finally {closeSync(fd);}
}
