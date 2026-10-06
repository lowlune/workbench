import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, uid } from '../server/store.mjs';
function fixture(t){const dir=mkdtempSync(path.join(os.tmpdir(),'workbench-store-'));let store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,get store(){return store;},reopen(){store.close();store=new Store(dir);return store;}};}
test('accepted messages survive restart, duplicate delivery is idempotent, payload conflicts are rejected',t=>{
  const f=fixture(t);const c=f.store.createConversation({directory:'/tmp',model:'provider/model'});const id=uid();
  f.store.accept(c.id,{text:'one',attachments:[]},'provider/model',null,id);
  const s=f.reopen();assert.equal(s.accept(c.id,{text:'one',attachments:[]},'provider/model',null,id).id,id);
  assert.equal(s.messages(c.id).messages.length,1);
  assert.throws(()=>s.accept(c.id,{text:'different',attachments:[]},'provider/model',null,id),/another input/);
});
test('rollback does not publish phantom events',async t=>{
  const {store}=fixture(t);const events=[];store.listeners.add(e=>events.push(e));
  assert.throws(()=>store.transaction(()=>{store.event('invalid',null);throw new Error('rollback');}));
  await new Promise(r=>setImmediate(r));assert.equal(events.length,0);assert.equal(store.sequence(),0);
});
test('recovery marks active work interrupted and pauses the durable queue',t=>{
  const f=fixture(t);const c=f.store.createConversation({directory:'/tmp'});const id=uid();
  f.store.accept(c.id,{text:'one',attachments:[]},'p/m',null,id);f.store.status(id,'running');
  f.store.accept(c.id,{text:'two',attachments:[]},'p/m',null,uid());
  const s=f.reopen();s.recover();const view=s.view(s.conversation(c.id));assert.equal(view.paused,true);assert.equal(view.queued.length,1);
  assert.equal(s.db.prepare('SELECT status FROM commands WHERE id=?').get(id).status,'interrupted');
});
test('queued follow-ups do not mask the current active run',t=>{
  const {store}=fixture(t);const c=store.createConversation({directory:'/tmp'});const first=uid();
  store.accept(c.id,{text:'one',attachments:[]},'p/m',null,first);store.status(first,'running');
  store.accept(c.id,{text:'two',attachments:[]},'p/m',null,uid());
  const view=store.view(store.conversation(c.id));assert.equal(view.resumeStatus,'working');assert.equal(view.activeRun.id,first);assert.equal(view.queued.length,1);
});
test('history cursor reaches conversations past the old 100 item cap',t=>{
  const {store}=fixture(t);for(let i=0;i<125;i++)store.createConversation({directory:'/tmp',title:`Chat ${i}`});
  const seen=new Set();let cursor;do{const page=store.list({before:cursor,limit:40});for(const c of page.sessions){assert.ok(!seen.has(c.id));seen.add(c.id);}cursor=page.nextCursor;}while(cursor);assert.equal(seen.size,125);
});
test('usage snapshots are upserts, including cache tokens, never double counted',t=>{
  const {store}=fixture(t);const c=store.createConversation({directory:'/tmp'});const info={tokens:{input:10,output:20,cache:{read:100}},cost:0.03};
  store.recordUsage('native-step',c.id,null,info);store.recordUsage('native-step',c.id,null,info);
  const u=store.db.prepare('SELECT count(*) AS n,sum(input) AS input,sum(cache_read) AS cached FROM usage').get();assert.equal(u.n,1);assert.equal(u.input,10);assert.equal(u.cached,100);
});
test('project resolution uses the longest path-segment ancestor',t=>{
  const {store}=fixture(t);store.db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('parent','Parent','/projects/app',null,0);store.db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('child','Child','/projects/app/packages/site',null,0);
  assert.equal(store.projectFor('/projects/app-old'),null);assert.equal(store.projectFor('/projects/app/packages/site/src').id,'child');
});
