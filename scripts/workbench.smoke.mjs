import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const secrets=JSON.parse(await readFile(`${process.env.HOME}/.config/secrets/workbench-cloudflare-secrets.json`,'utf8'));
const base=process.env.WORKBENCH_TEST_URL||'http://127.0.0.1:8788/api/v2';
const headers={'x-workbench-internal-key':secrets.WORKBENCH_PROXY_KEY,'content-type':'application/json'};
async function api(route,body,method){const response=await fetch(base+route,{headers,method:method||(body?'POST':'GET'),body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});const result=await response.json();if(!response.ok)throw new Error(`${route}: ${response.status} ${result.error}`);return result;}
const boot=await api('/bootstrap');assert.ok(boot.projects.length);console.log('bootstrap',boot.sessions.length,'root conversations',boot.projects.length,'projects');
const {models}=await api('/models');for(const engine of ['opencode','pi'])assert.ok(models.some(m=>m.engine===engine),`${engine} has models`);
console.log('models',models.reduce((out,m)=>(out[m.engine]=(out[m.engine]||0)+1,out),{}));
const ids=[];
for(const engine of ['opencode','pi']){
  const model=models.find(m=>m.engine===engine&&m.id==='opencode-go/deepseek-v4-flash')||models.find(m=>m.engine===engine&&m.provider==='opencode-go');
  assert.ok(model,`${engine} Go connection`);
  const id=`chat_${randomUUID()}`;const c=await api('/conversations',{id,title:`Integration smoke ${engine}`,engine,projectId:null,model:model.id,mode:'plan'});assert.equal(c.session.id,id);
  const commandId=randomUUID();const prompt={clientCommandId:commandId,text:`Reply exactly WORKBENCH_${engine.toUpperCase()}_OK. Do not use any tools.`,attachmentIds:[],model:model.id};
  const accepted=await api(`/conversations/${id}/commands`,prompt);assert.equal(accepted.commandId,commandId);
  const duplicate=await api(`/conversations/${id}/commands`,prompt);assert.equal(duplicate.commandId,commandId);
  ids.push({id,commandId,engine,model:model.id});console.log('accepted idempotently',engine);
}
for(const item of ids){
  const deadline=Date.now()+180000;let status;
  while(Date.now()<deadline){status=(await api(`/commands/${item.commandId}`)).status;if(['succeeded','failed','uncertain','interrupted','cancelled'].includes(status))break;await new Promise(r=>setTimeout(r,1500));}
  const {session}=await api(`/conversations/${item.id}`);
  assert.equal(status,'succeeded',`${item.engine}: ${session.activeRun?.error}`);
  assert.equal(session.messages.filter(m=>m.info.role==='user').length,1);
  assert.ok(session.messages.some(m=>m.info.role==='assistant'&&m.parts.some(p=>p.text?.includes(`WORKBENCH_${item.engine.toUpperCase()}_OK`))),`${item.engine} reply is persisted`);
  console.log('runtime PASS',item.engine,session.messages.length,'messages');
}
const usage=await api('/usage?days=1');assert.ok(usage.totals.requests>=2);console.log('usage PASS',usage.totals.requests,'requests');
await api('/clips',{text:'Integration fixture',projectId:boot.projects[0].id});const clips=await api(`/clips?projectId=${boot.projects[0].id}`);const clip=clips.clips.find(c=>c.text==='Integration fixture');assert.ok(clip);await api(`/clips/${clip.id}`,undefined,'DELETE');console.log('scoped clips PASS');
for(const item of ids)await api(`/conversations/${item.id}`,{hidden:true},'PATCH');
console.log('PASS: both engines, durable inputs, deduplication, transcripts, usage, project clips');
