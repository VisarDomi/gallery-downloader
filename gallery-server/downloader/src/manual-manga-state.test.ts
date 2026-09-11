import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { readerBackups } from './reader-backups.js';
import { ManualMangaState } from './manual-manga-state.js';
const snapshot = (chapter='2', updatedAt=100) => ({version:1,indexedDB:{progress:[{id:'asurascans\0fixture',provider:'asurascans',seriesSlug:'fixture',chapterId:chapter,imageIndex:2,totalImages:10,updatedAt}],tokens:[],metadata:[{key:'progress-schema-version',value:3}]}});
test('manual save replaces older/backward/empty state without merging and retains previous', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-manga-'));
 try {
 const store=new ManualMangaState(root);store.save('asurascans',snapshot('9',200));store.save('asurascans',snapshot('2',100));
 assert.deepEqual(new ManualMangaState(root).read('asurascans'),snapshot('2',100));
 const empty=snapshot();empty.indexedDB.progress=[];store.save('asurascans',empty);
 assert.deepEqual(store.read('asurascans'),empty);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'manual-manga-asurascans.json'),'utf8')).previous,snapshot('2',100));
 assert.throws(()=>store.save('asurascans',{version:1}));assert.deepEqual(store.read('asurascans'),empty);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('discovery contains no history; Load/Save are authenticated and old automatic feed is retired', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-api-')),app=express();app.use('/api/reader-backups',readerBackups(root));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/reader-backups`,url=base+'/manual/manga-reader/asurascans';
 assert.equal((await fetch(url+'/status')).status,401);
 const headers={'X-Reader-Backup-Key':fs.readFileSync(path.join(root,'access-key'),'utf8'),'Content-Type':'application/json',Origin:'https://asurascans.com'};
 assert.deepEqual(await (await fetch(url+'/status',{headers})).json(),{available:true});
 assert.equal((await fetch(url,{headers})).status,404);
 const put=await fetch(url,{method:'PUT',headers,body:JSON.stringify(snapshot())});assert.equal(put.status,200);assert.equal(put.headers.get('Access-Control-Allow-Origin'),'https://asurascans.com');
 assert.deepEqual(await (await fetch(url,{headers})).json(),snapshot());
 assert.equal((await fetch(base+'/library/asurascans',{method:'PUT',headers,body:'{}'})).status,410);
 assert.deepEqual(await (await fetch(url,{headers})).json(),snapshot());
});
