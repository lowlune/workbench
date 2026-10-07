import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const uid = (prefix = '') => `${prefix}${randomUUID()}`;
export const decode = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const canonical = (value) => { const result = realpathSync(value); if (!statSync(result).isDirectory()) throw fail('Folder is not a directory.'); return result; };

/* Run lifecycle (PLAN §9). `queued` waits in the scheduler; capacity statuses
   occupy a worker slot; `waiting_for_*` are blocked on the user and retain
   their resident worker slot. Legacy names are still accepted on
   write and normalized to the new vocabulary. */
export const RUN_CAPACITY = ['starting', 'running', 'interrupting'];
export const RUN_WAITING = ['waiting_for_user', 'waiting_for_permission'];
export const RUN_LIVE = [...RUN_CAPACITY, ...RUN_WAITING];
export const RUN_ACTIVE = [...RUN_LIVE, 'queued'];
export const RUN_TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted', 'interrupted_by_restart'];
const STATUS_ALIASES = { succeeded: 'completed', waiting: 'waiting_for_user', stopping: 'interrupting', uncertain: 'failed' };
export const normalizeStatus = (status) => STATUS_ALIASES[status] || status;

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'workbench.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
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
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(id UNINDEXED, conversation_id UNINDEXED, text, tokenize='unicode61');`);
    this.migrate();
    this.listeners = new Set();
    /* Full-text updates are debounced: streaming rewrites the same message
       many times per second and search only needs the settled text. */
    this.pendingSearch = new Map();
    this.searchTimers = new Map();
    this.metrics = { transientEvents: 0, durableEvents: 0, prunedEvents: 0 };
    this.pruneEvents();
  }

  addColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /* Idempotent, non-destructive migration. Existing chats, usage and
     projects are preserved; new columns default to safe values. */
  migrate() {
    for (const [table, column, definition] of [
      ['commands', 'engine', 'TEXT'],
      ['commands', 'provider', 'TEXT'],
      ['commands', 'worktree_id', 'TEXT'],
      ['commands', 'heartbeat', 'INTEGER'],
      ['commands', 'attention', "TEXT NOT NULL DEFAULT 'none'"],
      ['commands', 'todos', 'TEXT'],
      ['commands', 'summary', 'TEXT'],
      ['commands', 'failure_code', 'TEXT'],
      ['commands', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['commands', 'retry_at', 'INTEGER'],
      ['events', 'kind', 'TEXT'],
      ['events', 'run_id', 'TEXT'],
      ['interactions', 'run_id', 'TEXT'],
      ['interactions', 'options', 'TEXT'],
      ['interactions', 'answers', 'TEXT'],
    ]) this.addColumn(table, column, definition);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worktrees(id TEXT PRIMARY KEY, project_id TEXT, conversation_id TEXT, run_id TEXT,
        path TEXT NOT NULL, branch TEXT, base_branch TEXT, base_commit TEXT, status TEXT NOT NULL DEFAULT 'active',
        error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS worktrees_conversation ON worktrees(conversation_id,status);
      CREATE TABLE IF NOT EXISTS usage_limits(id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'global', provider TEXT,
        period TEXT NOT NULL DEFAULT 'monthly', limit_tokens INTEGER, limit_cost REAL, manual INTEGER NOT NULL DEFAULT 1,
        reset_at INTEGER, reported TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, kind TEXT NOT NULL, severity TEXT,
        conversation_id TEXT, run_id TEXT, title TEXT NOT NULL, body TEXT, read INTEGER NOT NULL DEFAULT 0,
        attention INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, delivered INTEGER, delivery TEXT);
      CREATE INDEX IF NOT EXISTS notifications_recent ON notifications(read,created DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup ON notifications(run_id,kind) WHERE run_id IS NOT NULL;
      UPDATE commands SET status='completed' WHERE status='succeeded';
      UPDATE commands SET status='waiting_for_user' WHERE status='waiting';
      UPDATE commands SET status='interrupting' WHERE status='stopping';
      UPDATE commands SET status='failed' WHERE status='uncertain';
      DROP INDEX IF EXISTS one_running_conversation;
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_conversation ON commands(conversation_id)
        WHERE status IN ('starting','running','waiting_for_user','waiting_for_permission','interrupting');
      PRAGMA user_version=2;`);
    this.addColumn('notifications', 'delivery', 'TEXT');
    this.addColumn('worktrees', 'root_directory', 'TEXT');
    this.db.exec(`UPDATE worktrees SET root_directory=(SELECT directory FROM conversations WHERE id=worktrees.conversation_id) WHERE root_directory IS NULL;`);
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
  publish(event){queueMicrotask(()=>{for(const listener of this.listeners){try{listener(event);}catch(error){console.warn(JSON.stringify({event:'event_listener_error',message:error.message}));}}});}
  getSetting(key, fallback = null) { return decode(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value, fallback); }
  setSetting(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  event(type, conversationId, data = {}, meta = {}) {
    const kind = meta.kind || type;
    const runId = meta.runId || data.runId || null;
    if (type === 'text.delta' || meta.transient) {
      this.metrics.transientEvents++;
      const event = { ...data, type, kind, conversationId, runId };
      if(this.pendingEvents)this.pendingEvents.push(event);else this.publish(event);
      return event;
    }
    // Live clients receive the snapshot; replay clients fetch the canonical row.
    const durable = type === 'message.updated' ? { messageId: data.message?.id } : data;
    const result = this.db.prepare('INSERT INTO events(type,conversation_id,data,created,kind,run_id) VALUES (?,?,?,?,?,?)').run(type, conversationId || null, JSON.stringify(durable), Date.now(), kind, runId);
    this.metrics.durableEvents++;
    if (this.metrics.durableEvents % 128 === 0) this.pruneEvents();
    const event = { seq: Number(result.lastInsertRowid), type, kind, conversationId, runId, ...data };
    // Notifications are deferred until after the surrounding synchronous transaction commits.
    if(this.pendingEvents)this.pendingEvents.push(event);else this.publish(event);
    return event;
  }
  sequence() { return Number(this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq || 0); }
  pruneEvents({ maxCount = 5000, maxAgeMs = 86400000, now = Date.now() } = {}) {
    const cutoff = this.db.prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?').get(Math.max(0, maxCount - 1))?.seq || 0;
    const result = this.db.prepare("DELETE FROM events WHERE type='text.delta' OR created<? OR seq<?").run(now - maxAgeMs, cutoff);
    this.metrics.prunedEvents += Number(result.changes);
    return Number(result.changes);
  }
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
  createConversation({ id = uid('chat_'), title = 'New conversation', engine = 'pi', directory, projectId = null, model = null, mode = 'build' }) {
    const now = Date.now();
    this.db.prepare('INSERT INTO conversations(id,title,engine,directory,project_id,model,mode,created,updated) VALUES (?,?,?,?,?,?,?,?,?)').run(id,title.slice(0,120),engine,directory,projectId,model,mode,now,now);
    this.event('conversation.changed',id);
    return this.conversation(id);
  }
  view(row, extra = {}) {
    const active = this.db.prepare(`SELECT * FROM commands WHERE conversation_id=? AND status IN (${RUN_LIVE.map(() => '?').join(',')}) ORDER BY created DESC,id DESC LIMIT 1`).get(row.id, ...RUN_LIVE);
    const busy = active && RUN_LIVE.includes(active.status);
    const interactions = this.db.prepare("SELECT * FROM interactions WHERE conversation_id=? AND status='pending' ORDER BY rowid").all(row.id).map(x=>({id:x.id,kind:x.kind,runId:x.run_id,...decode(x.data,{})}));
    const attention = interactions.some((item) => item.kind === 'permission') ? 'permission' : interactions.length ? 'waiting' : (active?.attention || 'none');
    const queued = this.db.prepare("SELECT id,input,model,status,created FROM commands WHERE conversation_id=? AND status='queued' ORDER BY created,id").all(row.id);
    return { id:row.id,title:row.title,engine:row.engine,directory:row.directory,projectId:row.project_id,modelPref:row.model,
      reasoning:row.reasoning,mode:row.mode,pinned:!!row.pinned,hidden:!!row.hidden,paused:!!row.paused,revision:row.revision,
      created:row.created,updated:row.updated,canResume:true,legacy:!!row.legacy_id,attention,
      status:busy ? 'working' : active?.status || 'idle',runStatus: active?.status || 'idle',resumeStatus:busy ? 'working':'idle',
      activeRun: active ? {id:active.id,status:active.status,error:active.error,failureCode:active.failure_code||null,model:active.model,provider:active.provider,engine:active.engine,worktreeId:active.worktree_id,heartbeat:active.heartbeat,todos:decode(active.todos,[])||[],attempts:active.attempts||0,retryAt:active.retry_at||null,started:active.started,ended:active.ended} : null,
      queued:queued.map((x,index)=>({id:x.id,...decode(x.input,{}),model:x.model,position:index,created:x.created})),
      interactions,...extra };
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
      const allowed={title:'title',model:'model',reasoning:'reasoning',pinned:'pinned',hidden:'hidden',projectId:'project_id',directory:'directory',paused:'paused'};
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
      const conversation=this.conversation(id);
      const count=this.db.prepare("SELECT count(*) AS n FROM commands WHERE conversation_id=? AND status='queued'").get(id).n;
      if(count>=50)throw fail('The queue contains 50 messages. Remove a queued message before adding another.',409);
      const now=Date.now();
      this.db.prepare('INSERT INTO commands(id,conversation_id,engine,hash,input,model,reasoning,status,created) VALUES (?,?,?,?,?,?,?,?,?)').run(commandId,id,conversation.engine||'opencode',hash,JSON.stringify(input),model,reasoning||null,'queued',now);
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
  status(commandId,status,error=null,failureCode=null) {
    const row=this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);if(!row)return;
    status=normalizeStatus(status);
    const terminal=RUN_TERMINAL.includes(status);
    this.transaction(()=>{
      this.db.prepare('UPDATE commands SET status=?,error=?,failure_code=?,started=coalesce(started,?),ended=?,heartbeat=?,retry_at=NULL WHERE id=?').run(status,error,failureCode,Date.now(),terminal?Date.now():null,Date.now(),commandId);
      this.db.prepare('UPDATE conversations SET updated=?,revision=revision+1 WHERE id=?').run(Date.now(),row.conversation_id);
      if(terminal && status!=='completed')this.db.prepare('UPDATE conversations SET paused=1 WHERE id=?').run(row.conversation_id);
      if(terminal)this.db.prepare("UPDATE interactions SET status='closed' WHERE conversation_id=? AND status IN ('pending','responding')").run(row.conversation_id);
      if(terminal)this.flushSearchAll();
      this.event('run.updated',row.conversation_id,{commandId,status,error,failureCode},{kind:'run.updated',runId:commandId});
    });
  }
  /* Automatic retry of a transient failure: return the same command to the queue
     with a not-before timestamp and an incremented attempt counter. Unlike a
     terminal failure this never pauses the conversation. */
  retry(commandId, attempt, retryAt) {
    const row=this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);if(!row)return;
    this.transaction(()=>{
      this.db.prepare("UPDATE commands SET status='queued',attempts=?,retry_at=?,error=NULL,failure_code=NULL,started=NULL,ended=NULL,native_message=NULL WHERE id=?").run(attempt,retryAt,commandId);
      this.db.prepare('UPDATE conversations SET paused=0,updated=?,revision=revision+1 WHERE id=?').run(Date.now(),row.conversation_id);
      this.event('run.updated',row.conversation_id,{commandId,status:'queued',attempt},{kind:'run.updated',runId:commandId});
    });
  }
  heartbeat(commandId) {
    this.db.prepare('UPDATE commands SET heartbeat=? WHERE id=?').run(Date.now(),commandId);
  }
  active(conversationId) {
    return this.db.prepare(`SELECT * FROM commands WHERE conversation_id=? AND status IN (${RUN_LIVE.map(()=>'?').join(',')})`).get(conversationId, ...RUN_LIVE) || null;
  }
  queued() {
    return Number(this.db.prepare("SELECT count(*) AS n FROM commands WHERE status='queued'").get().n);
  }
  recordUsage(id,conversationId,commandId,info,source='runtime-reported') {
    const t=info.tokens||{};if(!t.input&&!t.output&&!t.cache?.read&&!t.cache?.write)return;
    this.db.prepare(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,cost=excluded.cost`).run(id,conversationId,commandId,info.providerID||'',info.modelID||'',t.input||0,t.output||0,t.cache?.read||0,t.cache?.write||0,typeof info.cost==='number'?info.cost:null,source,Date.now());
  }
  /* Lease recovery (PLAN §16): a fresh control process owns no workers, so any
     run still marked live is stale. Mark it interrupted_by_restart instead of
     leaving it "running" forever. Worktrees are preserved for apply/discard. */
  recover() {
    const stale=this.db.prepare(`SELECT id FROM commands WHERE status IN (${RUN_LIVE.map(()=>'?').join(',')})`).all(...RUN_LIVE);
    for(const command of stale)this.status(command.id,'interrupted_by_restart','The control plane restarted while this run was active. Recorded work is preserved; review it before continuing.','restart_interrupted');
  }
  removeConversation(id) {
    return this.transaction(() => {
      const row = this.conversation(id);
      this.db.prepare('DELETE FROM messages WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM commands WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM interactions WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM artifacts WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM usage WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM message_search WHERE conversation_id=?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
      this.db.prepare('DELETE FROM settings WHERE key=?').run(`title.${id}`);
      this.db.prepare('DELETE FROM settings WHERE key=?').run(`handoff.${id}`);
      this.event('conversation.deleted', null, { id });
      return row;
    });
  }
  /* Keep the WAL bounded without blocking writers. PASSIVE never waits for
     readers; the periodic maintenance tick calls this so the -wal file cannot
     grow without limit under a long-lived control plane. */
  checkpoint(mode='PASSIVE'){try{this.db.exec(`PRAGMA wal_checkpoint(${mode})`);}catch(error){console.warn(JSON.stringify({event:'wal_checkpoint_failed',message:error.message}));}}
  close(){this.flushSearchAll();this.db.close();}
}
