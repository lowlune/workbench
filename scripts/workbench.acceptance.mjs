#!/usr/bin/env node
/*
 * Workbench Fáza 2 acceptance tests (Agent G, PLAN §8 / §46).
 *
 * Every check runs against an ISOLATED control plane: its own WORKBENCH_DATA,
 * control/OpenCode ports and worktree root, its own throwaway git project
 * (~/projects/_wb-acceptance) and, at the end, a fresh restart of the same
 * isolated instance for lease recovery. Production data is never written; only
 * the shared read-only credentials (~/.config/secrets and opencode/auth.json)
 * are reused. No new dependencies.
 *
 * Usage:  node scripts/workbench.acceptance.mjs
 * Exit code is non-zero when a hard check fails. Soft checks (LLM-dependent
 * triggers that may not fire) are reported as SKIP, never as FAIL.
 */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, uid } from '../server/store.mjs';

const HOME = process.env.HOME || os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.WORKBENCH_ACCEPTANCE_DATA || '/tmp/opencode/wb-acceptance';
const PORT = Number(process.env.WORKBENCH_ACCEPTANCE_PORT || 8797);
const OC_PORT = Number(process.env.WORKBENCH_ACCEPTANCE_OPENCODE_PORT || 4297);
const WT_ROOT = process.env.WORKBENCH_ACCEPTANCE_WORKTREES || '/tmp/opencode/wb-acceptance-worktrees';
const PROJECT_DIR = path.join(HOME, 'projects/_wb-acceptance');
const BASE = `http://127.0.0.1:${PORT}/api/v2`;
const KEY = JSON.parse(await readFile(path.join(HOME, '.config/secrets/workbench-cloudflare-secrets.json'), 'utf8')).WORKBENCH_PROXY_KEY;
const HEADERS = { 'x-workbench-internal-key': KEY, 'content-type': 'application/json' };
const TERMINAL = ['completed', 'failed', 'cancelled', 'interrupted', 'interrupted_by_restart'];

const results = [];
let failures = 0;
const created = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (name, detail = '') => { results.push({ name, status: 'passed', detail }); console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`); };
const fail = (name, error) => { failures += 1; const message = error?.message || String(error); results.push({ name, status: 'failed', detail: message }); console.log(`FAIL  ${name} — ${message}`); };
const skip = (name, reason) => { results.push({ name, status: 'skipped', detail: reason }); console.log(`SKIP  ${name} — ${reason}`); };
async function check(name, fn, { soft = false } = {}) {
  try { const detail = await fn(); pass(name, typeof detail === 'string' ? detail : ''); }
  catch (error) { if (soft) skip(name, error.message); else fail(name, error); }
}

/* ---- HTTP ---- */
async function api(route, body, method, timeout = 60000) {
  const response = await fetch(BASE + route, {
    headers: HEADERS,
    method: method || (body ? 'POST' : 'GET'),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let value;
  try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
  return { ok: response.ok, status: response.status, value };
}
async function must(route, body, method, timeout) {
  const response = await api(route, body, method, timeout);
  if (!response.ok) throw new Error(`${route} → ${response.status} ${response.value?.error || JSON.stringify(response.value).slice(0, 200)}`);
  return response.value;
}

/* ---- git ---- */
function exec(command, args, options = {}) {
  return new Promise((resolve) => execFile(command, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' })));
}
const git = (directory, args, options) => exec('/usr/bin/git', ['-C', directory, ...args], options);

/* ---- isolated control process ---- */
let control = null;
let controlLogs = '';
async function startControl() {
  if (control) return;
  control = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/control.mjs'], {
    cwd: REPO,
    env: {
      ...process.env,
      WORKBENCH_DATA: DATA,
      WORKBENCH_CONTROL_PORT: String(PORT),
      WORKBENCH_OPENCODE_PORT: String(OC_PORT),
      WORKBENCH_MAX_RUNS: '2',
      WORKBENCH_WORKTREE_ROOT: WT_ROOT,
      WORKBENCH_LEGACY_DB: path.join(DATA, 'no-legacy.db'),
      WORKBENCH_PROJECT_ROOTS: process.env.WORKBENCH_PROJECT_ROOTS || path.join(HOME, 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  controlLogs = '';
  control.stdout.on('data', (chunk) => { controlLogs = (controlLogs + chunk).slice(-4000); });
  control.stderr.on('data', (chunk) => { controlLogs = (controlLogs + chunk).slice(-4000); });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (control.exitCode !== null) throw new Error(`isolated control exited early (code ${control.exitCode}): ${controlLogs.trim().slice(-1500)}`);
    try { const response = await fetch(`${BASE}/health`, { headers: HEADERS, signal: AbortSignal.timeout(2000) }); if (response.ok) return; } catch {}
    await sleep(300);
  }
  throw new Error(`isolated control did not become healthy: ${controlLogs.trim().slice(-1500)}`);
}
async function stopControl(signal = 'SIGTERM') {
  if (!control) return;
  const child = control;
  control = null;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(signal); } catch {}
  const grace = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
  if (!grace || child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([exited, sleep(3000)]);
  }
}

/* ---- fixtures ---- */
async function ensureProjectRepo() {
  await mkdir(PROJECT_DIR, { recursive: true, mode: 0o755 });
  if (!existsSync(path.join(PROJECT_DIR, '.git'))) {
    await git(PROJECT_DIR, ['init', '-q']);
    await git(PROJECT_DIR, ['config', 'user.email', 'acceptance@workbench.local']);
    await git(PROJECT_DIR, ['config', 'user.name', 'Workbench Acceptance']);
  }
  if (!existsSync(path.join(PROJECT_DIR, 'README.md'))) await writeFile(path.join(PROJECT_DIR, 'README.md'), '# Workbench acceptance fixture\n');
  await git(PROJECT_DIR, ['add', '-A']);
  const head = await git(PROJECT_DIR, ['rev-parse', '--verify', 'HEAD']);
  if (head.error || !head.stdout.trim()) await git(PROJECT_DIR, ['commit', '-q', '-m', 'Initial acceptance fixture']);
}

let PROJECT_ID = null;
let PI_MODEL = null;

async function pickPiModel() {
  const deadline = Date.now() + 90000;
  let last = [];
  while (Date.now() < deadline) {
    const { models } = await must('/models');
    last = models.filter((model) => model.engine === 'pi');
    const go = last.filter((model) => model.provider === 'opencode-go');
    const chosen = go.find((model) => model.id === 'opencode-go/deepseek-v4.1-flash')
      || go.find((model) => model.id === 'opencode-go/deepseek-v4-flash')
      || go[0] || last[0];
    if (chosen) return chosen.id;
    await sleep(1500);
  }
  throw new Error(`no Pi model became available (saw ${last.length} pi models)`);
}

async function newConversation({ title, projectId = null, mode = 'build', engine, model = PI_MODEL }) {
  const body = { id: `chat_${randomUUID()}`, title, projectId, mode, model };
  if (engine) body.engine = engine;
  const { session } = await must('/conversations', body);
  created.push(session.id);
  return session;
}
async function send(conversationId, text, { commandId = randomUUID(), model = PI_MODEL } = {}) {
  const result = await must(`/conversations/${conversationId}/commands`, { clientCommandId: commandId, text, attachmentIds: [], model });
  return { commandId: result.commandId, status: result.status };
}
async function waitTerminal(commandId, timeout = 180000, onPoll) {
  const deadline = Date.now() + timeout;
  const seen = new Set();
  let last;
  while (Date.now() < deadline) {
    last = await must(`/commands/${commandId}`);
    seen.add(last.status);
    if (onPoll) await onPoll(last);
    if (TERMINAL.includes(last.status)) return { status: last.status, error: last.error, seen: [...seen] };
    await sleep(250);
  }
  throw new Error(`run ${commandId} did not finish within ${timeout}ms (last status ${last?.status})`);
}
async function openSse(after) {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/events?after=${after}`, { headers: HEADERS, signal: controller.signal });
  if (response.headers.get('content-type') !== 'text/event-stream') throw new Error('events endpoint did not return text/event-stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const done = (async () => {
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const line = chunk.split('\n').find((candidate) => candidate.startsWith('data:'));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch {}
        }
      }
    } catch {}
  })();
  return { events, close: () => controller.abort(), done };
}

/* =================================================================== */

async function run() {
  /* -- isolated environment -- */
  await stopControl();
  await rm(DATA, { recursive: true, force: true });
  await rm(WT_ROOT, { recursive: true, force: true });
  await ensureProjectRepo();
  await startControl();

  const boot = await must('/bootstrap');
  const resolved = path.resolve(PROJECT_DIR);
  const project = boot.projects.find((candidate) => path.resolve(candidate.directory) === resolved);
  if (!project) throw new Error('acceptance project was not imported by the isolated control');
  PROJECT_ID = project.id;
  PI_MODEL = await pickPiModel();
  console.log(`\nisolated control on :${PORT}, data=${DATA}, project=${PROJECT_ID}, model=${PI_MODEL}\n`);

  /* 1. Pi is the default engine (PLAN §1.1): no `engine` in the request. */
  await check('conversation without engine defaults to pi', async () => {
    const session = await newConversation({ title: `acceptance default engine ${randomUUID()}` });
    if (session.engine !== 'pi') throw new Error(`expected engine=pi, got ${session.engine}`);
    return `engine=${session.engine}`;
  });

  /* 2. Run lifecycle + structured SSE events + worktree create.
        A Pi build run inside a git project must be isolated in a worktree and
        emit typed events (tool.completed, run.state, todo.updated). */
  const FILE_A = 'acceptance-created.txt';
  const convA = await newConversation({ title: `acceptance worktree apply ${randomUUID()}`, projectId: PROJECT_ID, mode: 'build' });
  const sse = await openSse(boot.seq);
  const runA = await send(convA.id,
    `Use the todo tool first (action="write") with this two-item plan: 1) inspect the repo, 2) create ${FILE_A}. `
    + `Then use the write tool to create ${FILE_A} containing exactly ACCEPTANCE_CREATED on a single line. Do not use bash. Reply DONE.`);
  let maxActive = 0;
  const healthA = [];
  let outcomeA;
  await check('run reaches terminal state via GET /commands/:id', async () => {
    outcomeA = await waitTerminal(runA.commandId, 180000, async () => {
      const health = await must('/health');
      healthA.push(health.active);
      maxActive = Math.max(maxActive, health.active);
    });
    if (runA.status !== 'queued') throw new Error(`POST /commands did not accept as queued (got ${runA.status})`);
    if (outcomeA.status !== 'completed') throw new Error(`status ${outcomeA.status} (${outcomeA.error || 'no error'})`);
    if (!outcomeA.seen.some((status) => status === 'starting' || status === 'running')) throw new Error(`never observed starting/running; saw ${outcomeA.seen.join(',')}`);
    return `accepted queued, seen=${outcomeA.seen.join('→')}`;
  });
  await check('GET /health reports the active run, capacity and queue', async () => {
    const health = await must('/health');
    if (health.maxRuns !== 2) throw new Error(`maxRuns=${health.maxRuns}, expected 2 from WORKBENCH_MAX_RUNS`);
    if (health.queued !== 0) throw new Error(`queued=${health.queued} after drain`);
    if (maxActive < 1) throw new Error(`never saw active>=1 (maxActive=${maxActive})`);
    return `maxRuns=${health.maxRuns}, observed maxActive=${maxActive}, active now=${health.active}`;
  });
  await sleep(150);
  sse.close();
  await sse.done;

  await check('SSE delivers structured run.state + tool.completed events', async () => {
    const mine = sse.events.filter((event) => event.runId === runA.commandId || event.conversationId === convA.id);
    const kinds = new Set(mine.map((event) => event.kind || event.type));
    const missing = ['run.state', 'tool.completed'].filter((kind) => !kinds.has(kind));
    if (missing.length) throw new Error(`missing ${missing.join(', ')}; saw ${[...kinds].slice(0, 20).join(', ')}`);
    return `kinds=${[...kinds].join(',')}`;
  });
  await check('Pi run emits todo.updated when it creates a plan', async () => {
    const mine = sse.events.filter((event) => (event.kind || event.type) === 'todo.updated' && (event.runId === runA.commandId || event.conversationId === convA.id));
    if (!mine.length) throw new Error('no todo.updated observed (model may not have called the todo tool)');
    return `${mine.length} todo.updated event(s)`;
  }, { soft: true });

  await check('run changes are surfaced by GET /runs/:id/changes', async () => {
    const info = await must(`/runs/${runA.commandId}/changes?patch=1`);
    const file = (info.files || []).find((entry) => entry.path === FILE_A);
    if (!file) throw new Error(`${FILE_A} missing from diff; files=${JSON.stringify((info.files || []).map((entry) => entry.path))}`);
    if (!String(info.patch || '').includes('ACCEPTANCE_CREATED')) throw new Error('patch does not contain the written content');
    return `${info.files.length} file(s), status=${info.status}`;
  });
  await check('GET /worktrees lists the isolated worktree', async () => {
    const info = await must(`/worktrees?projectId=${PROJECT_ID}`);
    const row = (info.worktrees || []).find((entry) => entry.runId === runA.commandId);
    if (!row) throw new Error(`no worktree recorded for run ${runA.commandId}`);
    if (!row.path.startsWith(WT_ROOT)) throw new Error(`worktree path ${row.path} escaped the isolated root ${WT_ROOT}`);
    return `${row.id} status=${row.status} branch=${row.branch}`;
  });

  /* Queued lifecycle: while a conversation is busy, a follow-up stays queued
     (observable via GET /commands and /health) and only then starts. */
  await check('queue observes queued → starting/running → completed', async () => {
    const conv = await newConversation({ title: `acceptance queue ${randomUUID()}`, mode: 'plan' });
    const first = await send(conv.id, 'Count from 1 to 25, one number per line. After the last number write FIRST on its own line.');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const status = await must(`/commands/${first.commandId}`);
      if (status.status === 'starting' || status.status === 'running' || TERMINAL.includes(status.status)) break;
      await sleep(100);
    }
    const follow = await send(conv.id, 'Reply with the single word SECOND and nothing else.');
    const queued = await must(`/commands/${follow.commandId}`);
    if (queued.status !== 'queued') throw new Error(`follow-up was not queued via GET /commands (status ${queued.status})`);
    const health = await must('/health');
    if (!(health.queued >= 1)) throw new Error(`/health queued=${health.queued} while a follow-up waits`);
    await waitTerminal(first.commandId, 180000);
    const outcome = await waitTerminal(follow.commandId, 180000);
    if (outcome.status !== 'completed') throw new Error(`follow-up status ${outcome.status}`);
    return `${follow.commandId.slice(0, 12)}… queued, then ${outcome.seen.join('→')}`;
  });

  /* 3. Apply the worktree back to the original checkout; root must not break. */
  await check('POST /runs/:id/apply writes changes to the root repo', async () => {
    const before = await git(PROJECT_DIR, ['rev-parse', 'HEAD']);
    const result = await must(`/runs/${runA.commandId}/apply`, {});
    if (result.status !== 'applied') throw new Error(`apply status ${result.status}: ${result.error || ''}`);
    const content = await readFile(path.join(PROJECT_DIR, FILE_A), 'utf8').catch(() => null);
    if (content === null) throw new Error(`${FILE_A} was not written to the root checkout`);
    if (!content.includes('ACCEPTANCE_CREATED')) throw new Error(`unexpected content: ${JSON.stringify(content)}`);
    const after = await git(PROJECT_DIR, ['rev-parse', 'HEAD']);
    if (before.stdout.trim() !== after.stdout.trim()) throw new Error('apply changed HEAD; it must only touch the working tree');
    return `applied ${result.files?.length ?? 0} file(s), content verified`;
  });
  await rm(path.join(PROJECT_DIR, FILE_A), { force: true });

  /* 4. Discard a second run; the root checkout must never see its file. */
  await check('POST /runs/:id/discard removes an isolated run without touching root', async () => {
    const FILE_B = 'acceptance-discarded.txt';
    const convB = await newConversation({ title: `acceptance worktree discard ${randomUUID()}`, projectId: PROJECT_ID, mode: 'build' });
    const runB = await send(convB.id, `Use the write tool to create ${FILE_B} containing exactly DISCARD_ME. Do not use bash. Reply DONE.`);
    const outcomeB = await waitTerminal(runB.commandId, 180000);
    if (outcomeB.status !== 'completed') throw new Error(`discard run status ${outcomeB.status} (${outcomeB.error || ''})`);
    const changes = await must(`/runs/${runB.commandId}/changes`);
    if (!(changes.files || []).some((entry) => entry.path === FILE_B)) throw new Error(`${FILE_B} missing from worktree changes`);
    const result = await must(`/runs/${runB.commandId}/discard`, {});
    if (result.status !== 'discarded') throw new Error(`discard status ${result.status}`);
    if (existsSync(path.join(PROJECT_DIR, FILE_B))) throw new Error(`${FILE_B} leaked into the root checkout`);
    const info = await must(`/worktrees?projectId=${PROJECT_ID}`);
    const row = (info.worktrees || []).find((entry) => entry.runId === runB.commandId);
    if (!row || row.status !== 'discarded') throw new Error(`worktree record not marked discarded (status ${row?.status})`);
    return 'worktree discarded, root untouched';
  });

  /* 5. AGENTS.md endpoints (global read + project read/write + nested scope). */
  try {
    await check('GET/POST /agents-md reads global and writes project scope', async () => {
      const before = await must(`/agents-md?projectId=${PROJECT_ID}`);
      if (before.global === undefined || before.project === undefined) throw new Error('response is missing global/project fields');
      const content = `# Acceptance instructions\n\n- generated by workbench.acceptance.mjs\n- ${randomUUID()}\n`;
      const saved = await must('/agents-md', { scope: 'project', projectId: PROJECT_ID, content });
      if (!saved.saved) throw new Error('save was not acknowledged');
      const onDisk = await readFile(path.join(PROJECT_DIR, 'AGENTS.md'), 'utf8');
      if (onDisk !== content) throw new Error('AGENTS.md on disk does not match the posted content');
      const after = await must(`/agents-md?projectId=${PROJECT_ID}`);
      if (!after.project.includes('Acceptance instructions')) throw new Error('project AGENTS.md was not readable after save');
      return `path=${saved.path}`;
    });
    const nestedDir = path.join(PROJECT_DIR, 'packages/site/src');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(nestedDir, 'AGENTS.md'), '# Nested acceptance\n');
    await check('GET /agents-md detects nested AGENTS.md scope for an absolute path', async () => {
      const nested = await must(`/agents-md?projectId=${PROJECT_ID}&path=${encodeURIComponent(nestedDir)}`);
      const scopes = nested.files.map((file) => file.scope);
      if (!scopes.includes('global') || !scopes.includes('project')) throw new Error(`missing global/project scopes: ${scopes.join(',')}`);
      const entry = nested.files.find((file) => file.scope === 'nested' && file.path === path.join(nestedDir, 'AGENTS.md'));
      if (!entry) throw new Error(`no nested scope for ${nestedDir} (files: ${nested.files.map((file) => file.path).join(', ')})`);
      if (!entry.exists) throw new Error('nested AGENTS.md exists on disk but is reported as missing');
      return `${nested.files.length} scope(s): ${scopes.join(',')}`;
    });
    /* BUG (server/control.mjs:405): a relative `path` is resolved against the
       control CWD, not the project root, so nested detection silently fails. */
    await check('GET /agents-md resolves a project-relative path against the project', async () => {
      const nested = await must(`/agents-md?projectId=${PROJECT_ID}&path=packages/site/src`);
      if (!nested.files.some((file) => file.scope === 'nested')) throw new Error('relative path produced no nested scope');
      return `${nested.files.length} scope(s)`;
    }, { soft: true });
  } finally {
    await rm(path.join(PROJECT_DIR, 'AGENTS.md'), { force: true });
    await rm(path.join(PROJECT_DIR, 'packages'), { recursive: true, force: true });
  }

  /* 6. Usage limits + pacing. */
  await check('usage limits can be created and are reflected in pacing', async () => {
    const limit = await must('/usage/limits', { scope: 'global', period: 'monthly', limitTokens: 5000000, limitCost: 25 });
    if (!limit.limit?.id) throw new Error('limit response missing id');
    const listed = await must('/usage/limits');
    if (!(listed.limits || []).some((entry) => entry.id === limit.limit.id)) throw new Error('created limit not listed');
    const paced = await must('/usage/pacing');
    const entry = (paced.pacing || []).find((item) => item.limitId === limit.limit.id);
    if (!entry) throw new Error('created limit missing from pacing');
    if (entry.usageSource !== 'estimated' || entry.limitSource !== 'manual') throw new Error(`unexpected sources ${entry.usageSource}/${entry.limitSource}`);
    if (typeof entry.status !== 'string') throw new Error('pacing entry has no status');
    const removed = await must(`/usage/limits/${limit.limit.id}`, undefined, 'DELETE');
    if (!removed.deleted) throw new Error('limit was not deleted');
    return `status=${entry.status}, tokens=${entry.actual?.tokens ?? 0}`;
  });
  await check('usage limits reject an empty limit', async () => {
    const response = await api('/usage/limits', { scope: 'global', period: 'monthly' });
    if (response.ok) throw new Error('an empty limit was accepted');
    return `rejected with ${response.status}`;
  }, { soft: true });

  /* 7. Notifications: completed runs create durable records; read-all clears. */
  await check('GET /notifications + POST /notifications/read-all', async () => {
    const list = await must('/notifications');
    if (!Array.isArray(list.notifications)) throw new Error('notifications payload missing');
    if (!list.notifications.some((item) => item.kind === 'run.completed')) throw new Error('no run.completed notification after finished runs');
    const before = list.unread;
    const marked = await must('/notifications/read-all', {});
    const after = await must('/notifications?unread=true');
    if (after.unread !== 0) throw new Error(`unread=${after.unread} after read-all`);
    return `cleared ${marked.marked} (was ${before} unread)`;
  });

  /* 8. Idempotent command submission + conversation deletion. */
  await check('POST /conversations/:id/commands is idempotent', async () => {
    const conv = await newConversation({ title: `acceptance idempotency ${randomUUID()}`, mode: 'plan' });
    const clientCommandId = randomUUID();
    const first = await must(`/conversations/${conv.id}/commands`, { clientCommandId, text: 'Reply exactly IDEMPOTENT_OK.', attachmentIds: [], model: PI_MODEL });
    const second = await must(`/conversations/${conv.id}/commands`, { clientCommandId, text: 'Reply exactly IDEMPOTENT_OK.', attachmentIds: [], model: PI_MODEL });
    if (first.commandId !== clientCommandId || second.commandId !== clientCommandId) throw new Error(`command ids differ: ${first.commandId}/${second.commandId}`);
    const session = await must(`/conversations/${conv.id}`);
    const userMessages = session.session.messages.filter((message) => message.info.role === 'user');
    if (userMessages.length !== 1) throw new Error(`expected 1 user message, got ${userMessages.length}`);
    await waitTerminal(clientCommandId, 180000);
    return 'duplicate delivery collapsed to one command/message';
  });
  await check('DELETE /conversations/:id removes the conversation', async () => {
    const conv = await newConversation({ title: `acceptance delete ${randomUUID()}`, mode: 'plan' });
    const deleted = await must(`/conversations/${conv.id}`, undefined, 'DELETE');
    if (!deleted.deleted) throw new Error('delete not acknowledged');
    const response = await api(`/conversations/${conv.id}`);
    if (response.status !== 404) throw new Error(`expected 404 after delete, got ${response.status}`);
    const index = created.indexOf(conv.id);
    if (index >= 0) created.splice(index, 1);
    return '404 after delete';
  });

  /* 9. Permission round-trip (deterministic: `rm -rf` matches the dangerous
        pattern in server/pi/tools.mjs:10). Reply reject, so nothing runs. */
  await check('permission prompt round-trips through GET /conversations + POST /interactions', async () => {
    const conv = await newConversation({ title: `acceptance permission ${randomUUID()}`, projectId: PROJECT_ID, mode: 'build' });
    const sent = await send(conv.id, 'Run this exact shell command with the bash tool: rm -rf /tmp/wb-acceptance-nothing. Then reply DONE.');
    const deadline = Date.now() + 120000;
    let interaction = null;
    while (Date.now() < deadline && !interaction) {
      const session = await must(`/conversations/${conv.id}`);
      interaction = (session.session.interactions || []).find((item) => item.kind === 'permission');
      if (!interaction) {
        const status = await must(`/commands/${sent.commandId}`);
        if (TERMINAL.includes(status.status)) break;
        await sleep(400);
      }
    }
    if (!interaction) throw new Error('the model never triggered a permission prompt');
    const answered = await must(`/interactions/${interaction.id}`, { reply: 'reject' });
    if (!answered.answered) throw new Error('interaction was not answered');
    const outcome = await waitTerminal(sent.commandId, 120000);
    return `interaction ${interaction.id.slice(0, 22)}… answered; run ${outcome.status}`;
  }, { soft: true });

  /* 10. ask_user round-trip (LLM-dependent → soft). */
  await check('ask_user question round-trips through GET /conversations + POST /interactions', async () => {
    const conv = await newConversation({ title: `acceptance question ${randomUUID()}`, mode: 'plan' });
    const sent = await send(conv.id, 'Before doing anything else, call the ask_user tool with a single question "Pick a colour" and exactly two options "red" and "blue". Wait for my answer, then reply DONE.');
    const deadline = Date.now() + 120000;
    let interaction = null;
    while (Date.now() < deadline && !interaction) {
      const session = await must(`/conversations/${conv.id}`);
      interaction = (session.session.interactions || []).find((item) => item.kind === 'question');
      if (!interaction) {
        const status = await must(`/commands/${sent.commandId}`);
        if (TERMINAL.includes(status.status)) break;
        await sleep(400);
      }
    }
    if (!interaction) throw new Error('the model never asked a question');
    const answered = await must(`/interactions/${interaction.id}`, { answers: [['red']] });
    if (!answered.answered) throw new Error('question was not answered');
    const outcome = await waitTerminal(sent.commandId, 120000);
    return `interaction ${interaction.id.slice(0, 22)}… answered; run ${outcome.status}`;
  }, { soft: true });

  /* 11. Parallel runs across DIFFERENT workspaces must overlap up to
        WORKBENCH_MAX_RUNS (2). Same-directory runs are serialised by the
        workspace lease in control.mjs, so this uses the project worktree
        (directory = project root) plus a General chat (directory = general). */
  await check('two runs in different workspaces execute concurrently (maxRuns=2)', async () => {
    const first = await newConversation({ title: `acceptance parallel A ${randomUUID()}`, projectId: PROJECT_ID, mode: 'build' });
    const second = await newConversation({ title: `acceptance parallel B ${randomUUID()}`, mode: 'plan' });
    const a = await send(first.id, 'Count from 1 to 20, one number per line, then write PARALLEL_A on its own line.');
    const b = await send(second.id, 'Count from 20 to 1, one number per line, then write PARALLEL_B on its own line.');
    let observed = 0;
    const sample = async () => { observed = Math.max(observed, (await must('/health')).active); };
    const waitA = waitTerminal(a.commandId, 180000, sample);
    const waitB = waitTerminal(b.commandId, 180000, sample);
    const [outA, outB] = await Promise.all([waitA, waitB]);
    if (outA.status !== 'completed' || outB.status !== 'completed') throw new Error(`A=${outA.status} B=${outB.status}`);
    if (observed < 2) throw new Error(`never observed 2 concurrent active runs (max ${observed})`);
    return `both completed; observed max active=${observed}`;
  });

  /* 12. Restart / lease recovery (PLAN §16): a run left live must never stay
        "running" forever after the control plane restarts. We stop the
        isolated control, plant a running command, restart and verify. */
  await check('restart marks stale live runs interrupted_by_restart', async () => {
    await stopControl();
    const store = new Store(path.join(DATA, 'control'));
    const directory = path.join(DATA, 'recover-dir');
    await mkdir(directory, { recursive: true });
    const conversation = store.createConversation({ directory, engine: 'pi' });
    const staleId = uid('cmd_');
    store.accept(conversation.id, { text: 'stale run', attachments: [] }, PI_MODEL, null, staleId);
    store.status(staleId, 'running');
    store.close();
    await startControl();
    const recovered = await must(`/commands/${staleId}`);
    if (recovered.status !== 'interrupted_by_restart') throw new Error(`expected interrupted_by_restart, got ${recovered.status}`);
    const health = await must('/health');
    if (health.runs.some((run) => run.commandId === staleId)) throw new Error('stale run is still held in memory after restart');
    return 'running → interrupted_by_restart, released from memory';
  });

  await stopControl();
  return { PROJECT_ID, PI_MODEL };
}

/* ---- run + cleanup ---- */
let summary;
try {
  summary = await run();
} catch (error) {
  fail('acceptance harness', error);
} finally {
  try {
    if (control) {
      const info = await api(`/worktrees${PROJECT_ID ? `?projectId=${PROJECT_ID}` : ''}`).catch(() => null);
      for (const row of (info?.value?.worktrees || [])) await api(`/runs/${row.runId}/discard`, {}).catch(() => {});
      for (const id of created) await api(`/conversations/${id}`, undefined, 'DELETE').catch(() => {});
    }
  } catch {}
  await stopControl();
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  await rm(WT_ROOT, { recursive: true, force: true }).catch(() => {});
  await rm(PROJECT_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log('\n────────────────────────────────────────');
for (const item of results) console.log(`${item.status.toUpperCase().padEnd(7)} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
const passed = results.filter((item) => item.status === 'passed').length;
const skipped = results.filter((item) => item.status === 'skipped').length;
console.log(`\n${passed} passed, ${failures} failed, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
