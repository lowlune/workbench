import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const secrets=JSON.parse(await readFile(`${process.env.HOME}/.config/secrets/workbench-cloudflare-secrets.json`,'utf8'));
const base=process.env.WORKBENCH_TEST_URL||'http://127.0.0.1:8788/api/v2';
const headers={'x-workbench-internal-key':secrets.WORKBENCH_PROXY_KEY,'content-type':'application/json'};
async function api(route,body,method){const response=await fetch(base+route,{headers,method:method||(body?'POST':'GET'),body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const value=await response.json();assert.ok(response.ok,`${route}: ${value.error}`);return value;}
const TERMINAL=['completed','cancelled','failed','interrupted','interrupted_by_restart'];
async function wait(id,commandId){const deadline=Date.now()+180000;while(Date.now()<deadline){const {session}=await api(`/conversations/${id}`);const result=await api(`/commands/${commandId}`);if(TERMINAL.includes(result.status)){assert.equal(result.status,'completed',session.activeRun?.error);return session;}await new Promise(r=>setTimeout(r,1000));}throw new Error('Run timeout');}
/* Polls the run lifecycle while sampling /health so we can prove transitions
   (queued → starting/running → completed) and the queue/capacity counters. */
async function waitLifecycle(id,commandId){const deadline=Date.now()+180000;const seen=new Set();let maxActive=0,health;while(Date.now()<deadline){health=await api('/health');maxActive=Math.max(maxActive,health.active);const result=await api(`/commands/${commandId}`);seen.add(result.status);if(TERMINAL.includes(result.status)){assert.equal(result.status,'completed',(await api(`/conversations/${id}`)).session.activeRun?.error);return {session:(await api(`/conversations/${id}`)).session,seen:[...seen],maxActive,maxRuns:health.maxRuns};}await new Promise(r=>setTimeout(r,200));}throw new Error('Run lifecycle timeout');}
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
  /* Fáza 2: sending while paused is an explicit continue → the POST unpauses
     and the command runs without an explicit /resume. */
  await api(`/conversations/${c.id}/stop`,{});
  assert.equal((await api(`/conversations/${c.id}`)).session.paused,true,'stop pauses the conversation');
  const queued=randomUUID();await api(`/conversations/${c.id}/commands`,{clientCommandId:queued,text:'Reply QUEUE_OK.',attachmentIds:[],model:next.id});
  assert.equal((await api(`/conversations/${c.id}`)).session.paused,false,'sending auto-resumes a paused conversation');
  const s3=await wait(c.id,queued);assert.ok(s3.messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.text?.includes('QUEUE_OK'))));console.log('PASS',engine,'paused → send auto-resume');
  await api(`/conversations/${c.id}`,{hidden:true},'PATCH');
}
/* Pi is the default engine (PLAN §1.1): a conversation created without `engine`
   must come back as pi. */
{
  const {session}=await api('/conversations',{id:`chat_${randomUUID()}`,title:'Pi default engine',projectId:null,mode:'plan'});
  assert.equal(session.engine,'pi',`default engine is pi, got ${session.engine}`);
  await api(`/conversations/${session.id}`,{hidden:true},'PATCH');
  console.log('PASS pi is the default engine');
}
/* paused → send is an explicit continue: the POST must clear `paused` and the
   queued message must run and finish (auto-resume, no /resume call). */
{
  const model=models.find(m=>m.engine==='pi'&&m.id==='opencode-go/deepseek-v4-flash')||models.find(m=>m.engine==='pi');assert.ok(model);
  const {session}=await api('/conversations',{id:`chat_${randomUUID()}`,title:'Auto resume on send',engine:'pi',projectId:null,model:model.id,mode:'plan'});
  const first=randomUUID();await api(`/conversations/${session.id}/commands`,{clientCommandId:first,text:'Reply exactly FIRST_OK.',attachmentIds:[],model:model.id});await wait(session.id,first);
  await api(`/conversations/${session.id}/stop`,{});
  assert.equal((await api(`/conversations/${session.id}`)).session.paused,true,'stop pauses the conversation');
  const next=randomUUID();const accepted=await api(`/conversations/${session.id}/commands`,{clientCommandId:next,text:'Reply exactly AUTO_RESUME_OK.',attachmentIds:[],model:model.id});
  assert.equal(accepted.status,'queued','the command is accepted as queued');
  assert.equal((await api(`/conversations/${session.id}`)).session.paused,false,'sending clears paused');
  const lifecycle=await waitLifecycle(session.id,next);
  assert.ok(lifecycle.seen.some(s=>s==='starting'||s==='running'),`starting/running observed (${lifecycle.seen.join(',')})`);
  assert.ok(lifecycle.maxActive>=1,`/health active>=1 (max ${lifecycle.maxActive})`);
  assert.ok(Number.isFinite(lifecycle.maxRuns),'/health reports maxRuns');
  assert.ok(lifecycle.session.messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.text?.includes('AUTO_RESUME_OK'))),'auto-resumed reply persisted');
  await api(`/conversations/${session.id}`,{hidden:true},'PATCH');
  console.log('PASS paused → send auto-resume; lifecycle',lifecycle.seen.join('→'),'maxActive',lifecycle.maxActive,'maxRuns',lifecycle.maxRuns);
}
/* Restart recovery cannot be exercised against production: restarting the prod
   control plane is forbidden (other agents + live traffic). The isolated
   acceptance suite (scripts/workbench.acceptance.mjs) plants a running command,
   restarts the control plane and asserts interrupted_by_restart. */
console.log('SKIP restart recovery against prod (requires control restart; covered by acceptance suite)');
const e=await api('/bootstrap');const controller=new AbortController();const events=await fetch(base+`/events?after=${e.seq}`,{headers,signal:controller.signal});assert.equal(events.headers.get('content-type'),'text/event-stream');const reader=events.body.getReader();
await api('/clips',{text:'Event verification'});const received=await reader.read();assert.ok(new TextDecoder().decode(received.value).includes('clips.changed'));controller.abort();
console.log('PASS SSE receives persisted events without polling');
