import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const secrets=JSON.parse(await readFile(`${process.env.HOME}/.config/secrets/workbench-cloudflare-secrets.json`,'utf8'));
const base=process.env.WORKBENCH_TEST_URL||'http://127.0.0.1:8788/api/v2';
const headers={'x-workbench-internal-key':secrets.WORKBENCH_PROXY_KEY,'content-type':'application/json'};
async function api(route,body,method){const response=await fetch(base+route,{headers,method:method||(body?'POST':'GET'),body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const value=await response.json();assert.ok(response.ok,`${route}: ${value.error}`);return value;}
async function wait(id,commandId){const deadline=Date.now()+180000;while(Date.now()<deadline){const {session}=await api(`/conversations/${id}`);const result=await api(`/commands/${commandId}`);if(['succeeded','cancelled','failed','uncertain','interrupted'].includes(result.status)){assert.equal(result.status,'succeeded',session.activeRun?.error);return session;}await new Promise(r=>setTimeout(r,1000));}throw new Error('Run timeout');}
const {models}=await api('/models');
const upload=await fetch(base+'/attachments?name=fixture.txt',{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'The verification word is silverpine.'});assert.ok(upload.ok);const {attachment}=await upload.json();
for(const engine of ['opencode','pi']){
  const first=models.find(m=>m.engine===engine&&m.id==='opencode-go/deepseek-v4-flash');
  const next=models.find(m=>m.engine===engine&&m.id==='opencode-go/deepseek-v4.1-flash')||first;assert.ok(first);
  const {session:c}=await api('/conversations',{id:`chat_${randomUUID()}`,title:`Workflow test ${engine}`,engine,projectId:null,model:first.id,mode:'plan'});
  const a=randomUUID();await api(`/conversations/${c.id}/commands`,{clientCommandId:a,text:'Read the attached note. Reply only with its verification word. Remember it for the next message.',attachmentIds:[attachment.id],model:first.id});
  const s1=await wait(c.id,a);assert.ok(s1.messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.text?.includes('silverpine'))));
  await api(`/conversations/${c.id}`,{model:next.id},'PATCH');
  const b=randomUUID();await api(`/conversations/${c.id}/commands`,{clientCommandId:b,text:'What verification word was in the previous attachment? Reply with just that word.',attachmentIds:[],model:next.id});
  const s2=await wait(c.id,b);const last=s2.messages.filter(m=>m.info.role==='assistant').at(-1);assert.ok(last.parts.some(p=>p.text?.includes('silverpine')));assert.equal(`${last.info.providerID}/${last.info.modelID}`,next.id);console.log('PASS',engine,'first attachment, resume context, model switch');
  await api(`/conversations/${c.id}/stop`,{});
  const queued=randomUUID();await api(`/conversations/${c.id}/commands`,{clientCommandId:queued,text:'Reply QUEUE_OK.',attachmentIds:[],model:next.id});
  assert.equal((await api(`/commands/${queued}`)).status,'queued');assert.equal((await api(`/conversations/${c.id}`)).session.paused,true);
  await api(`/conversations/${c.id}/resume`,{});await wait(c.id,queued);console.log('PASS',engine,'durable paused queue and resume');
  await api(`/conversations/${c.id}`,{hidden:true},'PATCH');
}
const e=await api('/bootstrap');const controller=new AbortController();const events=await fetch(base+`/events?after=${e.seq}`,{headers,signal:controller.signal});assert.equal(events.headers.get('content-type'),'text/event-stream');const reader=events.body.getReader();
await api('/clips',{text:'Event verification'});const received=await reader.read();assert.ok(new TextDecoder().decode(received.value).includes('clips.changed'));controller.abort();
console.log('PASS SSE receives persisted events without polling');
