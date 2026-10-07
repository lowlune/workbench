import { readFileSync } from 'node:fs';
import { newSession } from '../shared/auth.mjs';

const secrets = JSON.parse(readFileSync(`${process.env.HOME}/.config/secrets/workbench-cloudflare-secrets.json`, 'utf8'));
const token = await newSession(secrets.WORKBENCH_SESSION_SECRET);
const BASE = 'http://127.0.0.1:8787/api/v2';
const H = { cookie: `workbench_session=${token}`, 'content-type': 'application/json', origin: 'http://127.0.0.1:8787' };
const GENERAL = `${process.env.HOME}/.local/share/workbench/control/general`;
const MODEL = 'opencode-go/deepseek-v4-flash';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomUUID();

async function raw(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: H, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const must = async (p, b, m) => { const r = await raw(p, b, m); if (r.status >= 300) throw new Error(`${p} ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`); return r.body; };
const mkChat = (mode = 'build') => must('/conversations', { id: `chat_${uid()}`, engine: 'opencode', workspace: GENERAL, model: MODEL, mode });
const del = (id) => raw(`/conversations/${id}`, undefined, 'DELETE');

let fails = 0;
const check = (name, cond, detail = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };

// 1. empty message
{ const c = await mkChat(); const r = await raw(`/conversations/${c.session.id}/commands`, { text: '', attachmentIds: [], model: MODEL, clientCommandId: uid() }); check('empty message rejected', r.status === 400, `status=${r.status}`); await del(c.session.id); }
// 2. oversize message
{ const c = await mkChat(); const r = await raw(`/conversations/${c.session.id}/commands`, { text: 'x'.repeat(60001), attachmentIds: [], model: MODEL, clientCommandId: uid() }); check('oversize message rejected', r.status === 400, `status=${r.status}`); await del(c.session.id); }
// 3. invalid model
{ const r = await raw('/conversations', { id: `chat_${uid()}`, engine: 'opencode', workspace: GENERAL, model: 'nope/nope', mode: 'build' }); check('invalid model rejected', r.status >= 400 && r.status < 500, `status=${r.status}`); if (r.body?.session) await del(r.body.session.id); }
// 4/5. duplicate command id idempotency
{ const c = await mkChat(); const id = c.session.id; const key = uid(); const a = await must(`/conversations/${id}/commands`, { text: 'one', attachmentIds: [], model: MODEL, clientCommandId: key }); const b = await must(`/conversations/${id}/commands`, { text: 'one', attachmentIds: [], model: MODEL, clientCommandId: key }); check('duplicate command idempotent', a.commandId === b.commandId, `${a.commandId} vs ${b.commandId}`); const r = await raw(`/conversations/${id}/commands`, { text: 'different', attachmentIds: [], model: MODEL, clientCommandId: key }); check('duplicate id with different payload rejected', r.status === 409, `status=${r.status}`); await raw(`/commands/${a.commandId}`, undefined, 'DELETE'); await del(id); }
// 6/7. stop then send auto-resume
{ const c = await mkChat(); const id = c.session.id; await must(`/conversations/${id}/commands`, { text: 'Count slowly from 1 to 50, one number per line.', attachmentIds: [], model: MODEL, clientCommandId: uid() }); let working = false; for (let i = 0; i < 20; i++) { const { session } = await must(`/conversations/${id}`); if (session.status === 'working') { working = true; break; } await sleep(500); } check('run started for stop test', working); const stop = await raw(`/conversations/${id}/stop`, {}); const after = await must(`/conversations/${id}`); check('stop pauses conversation', stop.status === 200 && after.session.paused === true, `stop=${stop.status} paused=${after.session.paused}`); await must(`/conversations/${id}/commands`, { text: 'Reply exactly RESUMED_OK. Do not use tools.', attachmentIds: [], model: MODEL, clientCommandId: uid() }); const resumed = await must(`/conversations/${id}`); check('send while paused auto-resumes', resumed.session.paused === false, `paused=${resumed.session.paused}`); await sleep(1500); await raw(`/conversations/${id}/stop`, {}); await del(id); }
// 8. attachment upload + send
{ const up = await fetch(BASE + '/attachments?name=note.txt', { method: 'POST', headers: { cookie: H.cookie, origin: H.origin, 'content-type': 'text/plain' }, body: 'The secret word is platypus.', signal: AbortSignal.timeout(30000) }); const j = await up.json(); check('attachment upload', up.ok && j.attachment?.id, `status=${up.status}`); const c = await mkChat(); const id = c.session.id; const r = await raw(`/conversations/${id}/commands`, { text: 'Read the attachment.', attachmentIds: [j.attachment.id], model: MODEL, clientCommandId: uid() }); check('send with attachment accepted', r.status === 202, `status=${r.status}`); await sleep(1500); await raw(`/conversations/${id}/stop`, {}); await del(id); }
// 9. delete while running -> 409
{ const c = await mkChat(); const id = c.session.id; await must(`/conversations/${id}/commands`, { text: 'Count slowly from 1 to 100, one per line.', attachmentIds: [], model: MODEL, clientCommandId: uid() }); let working = false; for (let i = 0; i < 20; i++) { const { session } = await must(`/conversations/${id}`); if (session.status === 'working') { working = true; break; } await sleep(500); } const r = await raw(`/conversations/${id}`, undefined, 'DELETE'); check('delete while running rejected', r.status === 409, `status=${r.status}`); await raw(`/conversations/${id}/stop`, {}); await del(id); }
// 10. auth: no cookie -> 401
{ const r = await fetch(BASE + '/bootstrap', { headers: { origin: 'http://127.0.0.1:8787' }, signal: AbortSignal.timeout(15000) }); check('unauthenticated API rejected', r.status === 401, `status=${r.status}`); }

console.log(fails ? `\n${fails} EDGE FAILURE(S)` : '\nALL EDGE CASES PASS');
process.exit(fails ? 1 : 0);
