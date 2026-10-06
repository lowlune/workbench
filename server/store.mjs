import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const uid = (prefix = '') => `${prefix}${randomUUID()}`;
export const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const canonical = (value) => { const result = realpathSync(value); if (!statSync(result).isDirectory()) throw fail('Folder is not a directory.'); return result; };

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'workbench.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, directory TEXT UNIQUE NOT NULL, model TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(directory TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),git_common TEXT);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, title TEXT NOT NULL, engine TEXT NOT NULL, directory TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id), native_id TEXT, legacy_id TEXT, model TEXT, reasoning TEXT, mode TEXT NOT NULL DEFAULT 'build',
        pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_recent ON conversations(hidden,pinned,updated DESC,id);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), hash TEXT NOT NULL,
        input TEXT NOT NULL, model TEXT NOT NULL, reasoning TEXT, status TEXT NOT NULL, error TEXT, native_message TEXT,
        created INTEGER NOT NULL, started INTEGER, ended INTEGER);
      CREATE INDEX IF NOT EXISTS commands_queue ON commands(status,created,id);
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_conversation ON commands(conversation_id) WHERE status IN ('starting','running','waiting','stopping');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), command_id TEXT,
        created INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation_id,created,id);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, conversation_id TEXT, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
        hash TEXT NOT NULL, filename TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clips(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '', attachment_id TEXT REFERENCES attachments(id), pinned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, command_id TEXT, provider TEXT, model TEXT,
        input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
        cost REAL, source TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_date ON usage(created,conversation_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(id UNINDEXED, conversation_id UNINDEXED, text, tokenize='unicode61');
      PRAGMA user_version=1;`);
    this.listeners = new Set();
    /* Full-text updates are debounced: streaming rewrites the same message
       many times per second and search only needs the settled text. */
    this.pendingSearch = new Map();
    this.searchTimers = new Map();
  }
  queueSearch(id, conversationId, text) {
    this.pendingSearch.set(id, { conversationId, text });
    if (this.searchTimers.has(id)) return;
    const timer = setTimeout(() => this.flushSearch(id), 1000);
    timer.unref?.();
    this.searchTimers.set(id, timer);
  }
  flushSearch(id) {
    const timer = this.searchTimers.get(id);
    if (timer) { clearTimeout(timer); this.searchTimers.delete(id); }
    const entry = this.pendingSearch.get(id);
    if (!entry) return;
    this.pendingSearch.delete(id);
    this.db.prepare('DELETE FROM message_search WHERE id=?').run(id);
    this.db.prepare('INSERT INTO message_search VALUES (?,?,?)').run(id, entry.conversationId, entry.text);
  }
  flushSearchAll() {
    for (const id of [...this.pendingSearch.keys()]) this.flushSearch(id);
  }
  transaction(fn) {
    if(this.pendingEvents) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.pendingEvents=[];
    try { const result=fn();this.db.exec('COMMIT');const events=this.pendingEvents;this.pendingEvents=null;for(const event of events)this.publish(event);return result; }
    catch(e){this.db.exec('ROLLBACK');this.pendingEvents=null;throw e;}
  }
  publish(event){queueMicrotask(()=>{for(const listener of this.listeners)listener(event);});}
  getSetting(key, fallback = null) { return decode(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value, fallback); }
  setSetting(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  event(type, conversationId, data = {}) {
    const result = this.db.prepare('INSERT INTO events(type,conversation_id,data,created) VALUES (?,?,?,?)').run(type, conversationId || null, JSON.stringify(data), Date.now());
    const event = { seq: Number(result.lastInsertRowid), type, conversationId, ...data };
    // Notifications are deferred until after the surrounding synchronous transaction commits.
    if(this.pendingEvents)this.pendingEvents.push(event);else this.publish(event);
    return event;
  }
  sequence() { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events').get().seq); }
  projectFor(directory) {
    let real=directory;try{real=canonical(directory);}catch{}
    const roots=[...this.projects(),...this.db.prepare('SELECT p.id,p.name,w.directory FROM workspaces w JOIN projects p ON p.id=w.project_id').all()];
    return roots.filter(p => real === p.directory || real.startsWith(`${p.directory}${path.sep}`)).sort((a,b) => b.directory.length-a.directory.length)[0] || null;
  }
  projects() { return this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(p=>({...p,defaults:{opencode:this.getSetting(`project.${p.id}.opencode`,p.model),pi:this.getSetting(`project.${p.id}.pi`)},workspaces:this.db.prepare('SELECT directory FROM workspaces WHERE project_id=?').all(p.id).map(w=>w.directory)})); }
  addProject(directory, name) {
    const root = canonical(directory);
    const previous = this.db.prepare('SELECT * FROM projects WHERE directory=?').get(root);
    const workspace=this.db.prepare('SELECT project_id FROM workspaces WHERE directory=?').get(root);
    if(workspace)return this.projects().find(p=>p.id===workspace.project_id);
    let common=null;
    try{const value=execFileSync('/usr/bin/git',['-C',root,'rev-parse','--git-common-dir'],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']}).trim();common=realpathSync(path.resolve(root,value));}catch{}
    if(previous){this.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?,?)').run(root,previous.id,common);return previous;}
    const related=common?this.db.prepare('SELECT project_id FROM workspaces WHERE git_common=? LIMIT 1').get(common):null;
    if(related){this.db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(root,related.project_id,common);return this.projects().find(p=>p.id===related.project_id);}
    const id = uid('prj_');
    this.db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(id, String(name || path.basename(root)).slice(0,100), root, null, Date.now());
    this.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?,?)').run(root,id,common);
    this.event('projects.changed', null);
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  }
  conversation(id) { const row = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id); if (!row) throw fail('Conversation not found.',404); return row; }
  createConversation({ id = uid('chat_'), title = 'New conversation', engine = 'opencode', directory, projectId = null, model = null, mode = 'build' }) {
    const now = Date.now();
    this.db.prepare('INSERT INTO conversations(id,title,engine,directory,project_id,model,mode,created,updated) VALUES (?,?,?,?,?,?,?,?,?)').run(id,title.slice(0,120),engine,directory,projectId,model,mode,now,now);
    this.event('conversation.changed',id);
    return this.conversation(id);
  }
  view(row, extra = {}) {
    const active = this.db.prepare("SELECT * FROM commands WHERE conversation_id=? ORDER BY CASE WHEN status IN ('starting','running','waiting','stopping') THEN 0 ELSE 1 END,created DESC,id DESC LIMIT 1").get(row.id);
    const running = active && ['starting','running','waiting','stopping'].includes(active.status);
    return { id:row.id,title:row.title,engine:row.engine,directory:row.directory,projectId:row.project_id,modelPref:row.model,
      reasoning:row.reasoning,mode:row.mode,pinned:!!row.pinned,hidden:!!row.hidden,paused:!!row.paused,revision:row.revision,
      created:row.created,updated:row.updated,canResume:true,legacy:!!row.legacy_id,
      status:running ? 'working' : active?.status || 'idle',resumeStatus:running ? 'working':'idle',
      activeRun: active ? {id:active.id,status:active.status,error:active.error,model:active.model,started:active.started,ended:active.ended} : null,
      queued:this.db.prepare("SELECT id,input,model,status FROM commands WHERE conversation_id=? AND status='queued' ORDER BY created,id").all(row.id).map(x=>({id:x.id,...decode(x.input,{}),model:x.model})),
      interactions:this.db.prepare("SELECT * FROM interactions WHERE conversation_id=? AND status='pending'").all(row.id).map(x=>({id:x.id,kind:x.kind,...decode(x.data,{})})),...extra };
  }
  list({ projectId, q = '', before, limit = 40, hidden = false } = {}) {
    const clauses=['hidden=?']; const args=[Number(hidden)];
    if(projectId!==undefined && projectId!=='') { clauses.push(projectId==='general'?'project_id IS NULL':'project_id=?'); if(projectId!=='general')args.push(projectId); }
    if(q) {
      const words=q.match(/[\p{L}\p{N}_]+/gu)?.slice(0,12).map(x=>`"${x}"*`).join(' AND ');
      clauses.push(`(instr(lower(title),lower(?))>0${words?' OR id IN (SELECT conversation_id FROM message_search WHERE message_search MATCH ?)':''})`);
      args.push(q);if(words)args.push(words);
    }
    if(before) { const cursor=decode(Buffer.from(before,'base64url').toString()); if(!cursor || !Number.isFinite(cursor.updated))throw fail('Invalid cursor.'); clauses.push('(pinned < ? OR (pinned = ? AND (updated < ? OR (updated = ? AND id < ?))))');args.push(cursor.pinned,cursor.pinned,cursor.updated,cursor.updated,cursor.id); }
    const rows=this.db.prepare(`SELECT * FROM conversations WHERE ${clauses.join(' AND ')} ORDER BY pinned DESC,updated DESC,id DESC LIMIT ?`).all(...args,limit+1);
    const more=rows.length>limit;const page=rows.slice(0,limit);const last=page.at(-1);
    return {sessions:page.map(r=>this.view(r)),nextCursor:more?Buffer.from(JSON.stringify({pinned:last.pinned,updated:last.updated,id:last.id})).toString('base64url'):null};
  }
  patchConversation(id, patch, revision) {
    return this.transaction(()=>{
      const row=this.conversation(id);
      if(revision!==undefined && revision!==row.revision)throw fail('Conversation changed on another device. Refresh and try again.',409);
      const allowed={title:'title',model:'model',reasoning:'reasoning',pinned:'pinned',hidden:'hidden',projectId:'project_id',paused:'paused'};
      for(const [key,column] of Object.entries(allowed))if(Object.hasOwn(patch,key)){
        const value=['pinned','hidden','paused'].includes(key)?Number(Boolean(patch[key])):patch[key];
        this.db.prepare(`UPDATE conversations SET ${column}=? WHERE id=?`).run(value,id);
      }
      this.db.prepare('UPDATE conversations SET revision=revision+1,updated=? WHERE id=?').run(Date.now(),id);
      this.event('conversation.changed',id);
      return this.view(this.conversation(id));
    });
  }
  accept(id, input, model, reasoning, commandId) {
    if(!/^[\w-]{8,100}$/.test(commandId || ''))throw fail('A stable client command ID is required.');
    const hash=createHash('sha256').update(JSON.stringify({id,input,model,reasoning})).digest('hex');
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
      if(previous){if(previous.hash!==hash)throw fail('Command ID already belongs to another input.',409);return previous;}
      this.conversation(id);
      const count=this.db.prepare("SELECT count(*) AS n FROM commands WHERE conversation_id=? AND status='queued'").get(id).n;
      if(count>=50)throw fail('The queue contains 50 messages. Remove a queued message before adding another.',409);
      const now=Date.now();
      this.db.prepare('INSERT INTO commands(id,conversation_id,hash,input,model,reasoning,status,created) VALUES (?,?,?,?,?,?,?,?)').run(commandId,id,hash,JSON.stringify(input),model,reasoning||null,'queued',now);
      const message={id:`user_${commandId}`,created:now,commandId,info:{role:'user'},parts:[{id:`text_${commandId}`,type:'text',text:input.text},...(input.attachments||[]).map(a=>({id:a.id,type:'file',filename:a.name,mime:a.mime,url:`/api/v2/attachments/${a.id}`}))]};
      this.message(id,message,commandId);
      this.db.prepare('UPDATE conversations SET updated=?,revision=revision+1 WHERE id=?').run(now,id);
      this.flushSearchAll();
      this.event('command.accepted',id,{commandId});
      return this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
    });
  }
  message(conversationId, message, commandId = null) {
    const previous=this.db.prepare('SELECT data,revision FROM messages WHERE id=?').get(message.id);
    const data=JSON.stringify(message);
    if(previous?.data===data)return;
    this.db.prepare(`INSERT INTO messages(id,conversation_id,command_id,created,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=messages.revision+1`).run(message.id,conversationId,commandId,message.created||Date.now(),data);
    const text=message.parts.filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
    this.queueSearch(message.id,conversationId,text);
    this.event('message.updated',conversationId,{message:{...message,revision:(previous?.revision||0)+1}});
  }
  messages(id, before, limit=30) {
    let rows;
    if(before){const cursor=this.db.prepare('SELECT created,id FROM messages WHERE id=? AND conversation_id=?').get(before,id);if(!cursor)throw fail('Message cursor not found.',404);rows=this.db.prepare('SELECT * FROM messages WHERE conversation_id=? AND (created<? OR (created=? AND id<?)) ORDER BY created DESC,id DESC LIMIT ?').all(id,cursor.created,cursor.created,cursor.id,limit+1);}
    else rows=this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created DESC,id DESC LIMIT ?').all(id,limit+1);
    const hasMore=rows.length>limit;
    return {messages:rows.slice(0,limit).reverse().map(r=>({...decode(r.data,{}),revision:r.revision})),hasMoreMessages:hasMore};
  }
  status(commandId,status,error=null) {
    const row=this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);if(!row)return;
    const terminal=['succeeded','failed','cancelled','interrupted','uncertain'].includes(status);
    this.transaction(()=>{
      this.db.prepare('UPDATE commands SET status=?,error=?,started=coalesce(started,?),ended=? WHERE id=?').run(status,error,Date.now(),terminal?Date.now():null,commandId);
      this.db.prepare('UPDATE conversations SET updated=?,revision=revision+1 WHERE id=?').run(Date.now(),row.conversation_id);
      if(terminal && status!=='succeeded')this.db.prepare('UPDATE conversations SET paused=1 WHERE id=?').run(row.conversation_id);
      if(terminal)this.db.prepare("UPDATE interactions SET status='closed' WHERE conversation_id=? AND status='pending'").run(row.conversation_id);
      if(terminal)this.flushSearchAll();
      this.event('run.updated',row.conversation_id,{commandId,status,error});
    });
  }
  recordUsage(id,conversationId,commandId,info,source='runtime-reported') {
    const t=info.tokens||{};if(!t.input&&!t.output&&!t.cache?.read&&!t.cache?.write)return;
    this.db.prepare(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,cost=excluded.cost`).run(id,conversationId,commandId,info.providerID||'',info.modelID||'',t.input||0,t.output||0,t.cache?.read||0,t.cache?.write||0,typeof info.cost==='number'?info.cost:null,source,Date.now());
  }
  recover() {
    for(const command of this.db.prepare("SELECT id FROM commands WHERE status IN ('starting','running','waiting','stopping')").all())this.status(command.id,'interrupted','The runner restarted. Recorded work is preserved; review it before continuing.');
  }
  close(){this.flushSearchAll();this.db.close();}
}
