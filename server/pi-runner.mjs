import { readFile, mkdir } from 'node:fs/promises';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import path from 'node:path';

let session;
const send = value => { if(process.connected)process.send(value); };
process.on('message', async message => {
  if(message.type==='stop'){await session?.abort();return;}
  if(message.type!=='run' && message.type!=='models')return;
  try {
    const agentDir=path.join(message.dataDir,'pi');
    await mkdir(agentDir,{recursive:true,mode:0o700});
    const runtime=await ModelRuntime.create({authPath:path.join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:path.join(agentDir,'models-cache.json'),allowModelNetwork:false});
    // API keys can be reused without duplicating OAuth refresh-token ownership.
    const auth=JSON.parse(await readFile(path.join(process.env.HOME,'.local/share/opencode/auth.json'),'utf8').catch(()=>'{}'));
    for(const [provider,value] of Object.entries(auth))if(value.type==='api' && value.key && runtime.getProvider(provider) && !runtime.hasConfiguredAuth(provider))await runtime.setRuntimeApiKey(provider,value.key);
    const models=await runtime.getAvailable();
    if(message.type==='models') {
      send({type:'models',models:models.map(m=>({id:`${m.provider}/${m.id}`,provider:m.provider,name:m.name,contextLimit:m.contextWindow,outputLimit:m.maxTokens,images:m.input?.includes('image'),reasoning:m.reasoning,engine:'pi',cost:m.cost}))});
      process.disconnect();return;
    }
    const split=message.model.indexOf('/');
    const model=runtime.getModel(message.model.slice(0,split),message.model.slice(split+1));
    if(!model || !models.some(m=>m.id===model.id&&m.provider===model.provider))throw new Error('This model is not authenticated in Pi. Connect its API key in Usage & models.');
    const settingsManager=SettingsManager.inMemory({compaction:{enabled:true},retry:{enabled:true,maxRetries:2},cacheWarming:{mode:'off'}});
    const resourceLoader=new DefaultResourceLoader({cwd:message.directory,agentDir,settingsManager,noExtensions:true,noThemes:true,
      appendSystemPrompt:['You are running inside Workbench. Complete the user task using the available tools. Keep progress updates concise. Preserve existing user changes. Do not commit or deploy unless requested.']});
    await resourceLoader.reload();
    const manager=message.nativeId?SessionManager.open(message.nativeId):SessionManager.create(message.directory,path.join(agentDir,'sessions'));
    ({session}=await createAgentSession({cwd:message.directory,agentDir,modelRuntime:runtime,model,
      thinkingLevel:message.reasoning||'off',sessionManager:manager,settingsManager,resourceLoader,
      tools:message.mode==='plan'?['read','grep','find','ls']:['read','bash','edit','write','grep','find','ls']}));
    send({type:'binding',nativeId:session.sessionFile});
    let counter=0;let current;let lastError;
    const messages=new Map();const timers=new Map();
    function publish(m,immediate=false){
      if(timers.has(m.id)){if(!immediate)return;clearTimeout(timers.get(m.id));timers.delete(m.id);}
      const emit=()=>{timers.delete(m.id);send({type:'message',message:m});};
      if(immediate)emit();else timers.set(m.id,setTimeout(emit,80));
    }
    function content(m){return (m.content||[]).flatMap((p,i)=>p.type==='text'?[{id:`${current.id}_${i}`,type:'text',text:p.text}]:p.type==='toolCall'?[{id:p.id,type:'tool',tool:p.name,callID:p.id,state:{status:'pending',input:p.arguments,title:p.name}}]:[]);}
    session.subscribe(event=>{
      if(event.type==='message_start' && event.message.role==='assistant'){
        current={id:`pi_${message.commandId}_${++counter}`,created:Date.now(),info:{role:'assistant',providerID:model.provider,modelID:model.id,modelName:model.name,contextLimit:model.contextWindow},parts:[]};messages.set(current.id,current);
      }
      if(event.type==='message_update' && current){current.parts=content(event.message);publish(current);}
      if(event.type==='message_end' && event.message.role==='assistant' && current){
        current.parts=content(event.message);const u=event.message.usage;
        if(u)current.info={...current.info,tokens:{input:u.input,output:u.output,cache:{read:u.cacheRead,write:u.cacheWrite}},cost:u.cost?.total};
        if(event.message.stopReason==='error')lastError=event.message.errorMessage||'Pi model request failed.';
        publish(current,true);
      }
      if(event.type==='tool_execution_start'||event.type==='tool_execution_end')for(const m of messages.values()){
        const part=m.parts.find(p=>p.callID===event.toolCallId);if(!part)continue;
        part.state={...part.state,status:event.type==='tool_execution_start'?'running':event.isError?'error':'completed',
          ...(event.result?{output:(event.result.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')}:{})};publish(m,true);
      }
      if(event.type==='auto_retry_start'||event.type==='compaction_start')send({type:'activity',activity:event.type});
    });
    const images=[];let text=message.text;
    for(const attachment of message.attachments||[]){
      const bytes=await readFile(attachment.filePath);
      if(attachment.mime.startsWith('image/'))images.push({type:'image',data:bytes.toString('base64'),mimeType:attachment.mime});
      else text+=`\n\nAttached file (${attachment.name}):\n${bytes.toString('utf8').slice(0,100000)}`;
    }
    await session.prompt(text,{images,expandPromptTemplates:false});
    await session.waitForIdle();
    for(const timer of timers.values())clearTimeout(timer);
    for(const m of messages.values())publish(m,true);
    session.dispose();session=undefined;send({type:'done',error:lastError||null});
  }catch(error){session?.dispose();session=undefined;send({type:'done',error:error.message});if(message.type==='models')process.disconnect();}
});
process.on('disconnect',()=>{session?.dispose();process.exit(0);});
