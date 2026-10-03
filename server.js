import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || os.homedir();
const PROJECTS = path.join(HOME, 'projects');
const DATA = process.env.WORKBENCH_DATA || path.join(ROOT, 'data');
const INBOX = path.join(DATA, 'inbox');
const CLIPS = path.join(DATA, 'clips');
const LOGIN_FAILURES_FILE = path.join(DATA, 'login-failures.json');
const DB_PATH = path.join(HOME, '.local/share/opencode/opencode.db');
const MODEL_CATALOG_FILE = path.join(DATA, 'model-catalog.json');
const PORT = Number(process.env.PORT || 8787);
const HERDR = path.join(HOME, '.local/bin/herdr');
const OPENCODE_CLI = path.join(HOME, '.opencode/bin/opencode');
const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const SECRET_FILE = path.join(HOME, '.config/secrets/workbench-cloudflare-secrets.json');
const SESSION_TTL = 14 * 24 * 60 * 60;
let SECRET_VALUES = {};
try { SECRET_VALUES = JSON.parse(readFileSync(SECRET_FILE, 'utf8')) || {}; } catch {}
let MODEL_CATALOG = {};
try { MODEL_CATALOG = JSON.parse(readFileSync(MODEL_CATALOG_FILE, 'utf8')) || {}; } catch {}
const INTERNAL_PROXY_KEY = process.env.WORKBENCH_PROXY_KEY || SECRET_VALUES.WORKBENCH_PROXY_KEY || '';
const WORKBENCH_LOGIN_KEY = process.env.WORKBENCH_LOGIN || SECRET_VALUES.WORKBENCH_LOGIN || '';
const WORKBENCH_SESSION_SECRET = process.env.WORKBENCH_SESSION_SECRET || SECRET_VALUES.WORKBENCH_SESSION_SECRET || '';
const PUBLIC_LOGIN_PATHS = new Set([
  '/login',
  '/login.html',
  '/login.css',
  '/login.js',
  '/fonts/inter.css',
  '/fonts/inter-latin-wght-normal.woff2',
  '/fonts/inter-latin-ext-wght-normal.woff2',
]);
const MAX_BODY = 30 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_CLIPS = 100;
const MESSAGE_PAGE_SIZE = 30;
const MESSAGE_UPDATE_SIZE = 20;
const AGENT_START_MEMORY = 1024 * 1024 * 1024;
const MIME_EXT = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const loginFailures = new Map();
let clipMutationQueue = Promise.resolve();
let loginPersistQueue = Promise.resolve();
let taskStartInProgress = false;
const previewCache = new Map();
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 60_000;
const savedSessionStarts = new Set();

await mkdir(INBOX, { recursive: true, mode: 0o700 });
await mkdir(CLIPS, { recursive: true, mode: 0o700 });
await loadLoginFailures();
const loginFailurePruner = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [ip, entry] of loginFailures) {
    if (entry.windowEnds <= now && entry.lockedUntil <= now) {
      loginFailures.delete(ip);
      changed = true;
    }
  }
  if (changed) persistLoginFailures().catch(() => {});
}, 60_000);
loginFailurePruner.unref();

async function pruneInbox() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const entry of await readdir(INBOX, { withFileTypes: true })) {
    if (!entry.isFile() || !/^inbox-[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(entry.name)) continue;
    const filePath = path.join(INBOX, entry.name);
    try {
      if ((await stat(filePath)).mtimeMs < cutoff) await unlink(filePath);
    } catch {}
  }
}
await pruneInbox();
const inboxPruner = setInterval(pruneInbox, 24 * 60 * 60 * 1000);
inboxPruner.unref();
await pruneClipFiles();
const clipPruner = setInterval(pruneClipFiles, 24 * 60 * 60 * 1000);
clipPruner.unref();

const opencodeDb = new DatabaseSync(DB_PATH, { readOnly: true });
opencodeDb.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 3000;');

const qSessions = opencodeDb.prepare(`
  SELECT id, title, directory, parent_id AS parentID, time_created AS created,
         time_updated AS updated, time_archived AS archived, cost,
         tokens_input AS inputTokens, tokens_output AS outputTokens,
         agent, model
  FROM session
  ORDER BY time_updated DESC
  LIMIT ?
`);
const qSession = opencodeDb.prepare(`
  SELECT id, title, directory, parent_id AS parentID, time_created AS created,
         time_updated AS updated, time_archived AS archived, cost,
         tokens_input AS inputTokens, tokens_output AS outputTokens,
         agent, model
  FROM session WHERE id = ?
`);
const qMessages = opencodeDb.prepare(`
  SELECT id, time_created AS created, data
  FROM message WHERE session_id = ?
  ORDER BY time_created DESC, id DESC LIMIT ? OFFSET ?
`);
const qMessageCount = opencodeDb.prepare('SELECT COUNT(*) AS total FROM message WHERE session_id = ?');
const qMessageCursor = opencodeDb.prepare('SELECT id, time_created AS created FROM message WHERE session_id = ? AND id = ?');
const qMessagesBefore = opencodeDb.prepare(`
  SELECT id, time_created AS created, data
  FROM message
  WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
  ORDER BY time_created DESC, id DESC LIMIT ?
`);
const qMessagesBeforeCount = opencodeDb.prepare(`
  SELECT COUNT(*) AS total FROM message
  WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
`);
const qFilePart = opencodeDb.prepare('SELECT data FROM part WHERE id = ? AND session_id = ?');
const qLatestText = opencodeDb.prepare(`
  SELECT p.data
  FROM part p JOIN message m ON m.id = p.message_id
  WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'text'
  ORDER BY m.time_created DESC, p.time_created DESC LIMIT 1
`);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseDbJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function safeMessageInfo(info) {
  const safe = { role: info.role === 'user' ? 'user' : 'assistant' };
  for (const key of ['agent', 'modelID', 'providerID', 'variant', 'mode']) {
    if (typeof info[key] === 'string' && info[key].length <= 120) safe[key] = info[key];
  }
  if (safe.modelID && safe.providerID) {
    const model = MODEL_CATALOG[`${safe.providerID}/${safe.modelID}`];
    if (model?.name) safe.modelName = model.name;
    if (Number.isSafeInteger(model?.contextLimit) && model.contextLimit > 0) safe.contextLimit = model.contextLimit;
    if (Number.isSafeInteger(model?.outputLimit) && model.outputLimit > 0) safe.outputLimit = model.outputLimit;
  }
  if (info.tokens && typeof info.tokens === 'object') {
    const tokens = {};
    for (const key of ['input', 'output', 'reasoning', 'total']) {
      const value = Number(info.tokens[key]);
      if (Number.isSafeInteger(value) && value >= 0) tokens[key] = value;
    }
    if (info.tokens.cache && typeof info.tokens.cache === 'object') {
      const cache = {};
      for (const key of ['read', 'write']) {
        const value = Number(info.tokens.cache[key]);
        if (Number.isSafeInteger(value) && value >= 0) cache[key] = value;
      }
      if (Object.keys(cache).length) tokens.cache = cache;
    }
    if (Object.keys(tokens).length) safe.tokens = tokens;
  }
  return safe;
}

function modelDetails(raw) {
  const model = parseDbJson(raw || 'null');
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const providerID = typeof model.providerID === 'string' ? model.providerID : '';
  const id = typeof model.id === 'string' ? model.id : '';
  const catalog = MODEL_CATALOG[`${providerID}/${id}`];
  return { ...model, ...(catalog && typeof catalog === 'object' ? catalog : {}) };
}

function parseMessages(rows, sessionId) {
  if (!rows.length) return [];
  const messageIds = rows.map((message) => message.id);
  const placeholders = messageIds.map(() => '?').join(',');
  const parts = opencodeDb.prepare(`
    SELECT message_id AS messageId, id, data
    FROM part
    WHERE message_id IN (${placeholders})
    ORDER BY time_created ASC
  `).all(...messageIds);
  const partsByMessage = new Map();
  for (const part of parts) {
    if (!partsByMessage.has(part.messageId)) partsByMessage.set(part.messageId, []);
    partsByMessage.get(part.messageId).push(safePart(part, sessionId));
  }
  return rows.map((message) => {
    const info = parseDbJson(message.data);
    return {
      id: message.id,
      created: message.created,
      info: safeMessageInfo(info),
      parts: partsByMessage.get(message.id) || [],
    };
  });
}

function safePart(row, sessionId) {
  const source = parseDbJson(row.data);
  const id = row.id;
  if (source.type === 'reasoning' || source.type === 'step-start' || source.type === 'step-finish') {
    return { id, type: source.type };
  }
  if (source.type === 'text') {
    const text = typeof source.text === 'string' ? source.text : '';
    return {
      id,
      type: 'text',
      text: text.length > 120_000 ? `${text.slice(0, 120_000)}\n\n[Message clipped in this view.]` : text,
    };
  }
  if (source.type === 'file') {
    const url = typeof source.url === 'string' && source.url.startsWith('data:image/')
      ? `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(id)}`
      : '';
    return { id, type: 'file', mime: source.mime || '', filename: source.filename || '', url };
  }
  if (source.type === 'tool') {
    const original = source.state && typeof source.state === 'object' ? source.state : {};
    const state = {};
    for (const key of ['status', 'title', 'time']) {
      if (original[key] !== undefined) state[key] = original[key];
    }
    for (const key of ['output', 'error', 'raw']) {
      const value = original[key];
      if (typeof value === 'string') state[key] = value.length > 16_000 ? `${value.slice(0, 16_000)}\n[Output clipped]` : value;
    }
    if (original.input !== undefined) {
      state.input = JSON.stringify(original.input).length > 12_000
        ? { note: 'Large tool input omitted from this view.' }
        : original.input;
    }
    return { id, type: 'tool', tool: source.tool || 'Tool', callID: source.callID, state };
  }
  return { id, type: typeof source.type === 'string' ? source.type : 'unknown' };
}

function parseOpencodeRow(row, options = {}) {
  const latest = Object.hasOwn(options, 'latestText')
    ? parseDbJson(options.latestText || '{}')
    : parseDbJson(qLatestText.get(row.id)?.data || '{}');
  const result = {
    id: row.id,
    title: row.title,
    directory: row.directory,
    parentID: row.parentID,
    created: row.created,
    updated: row.updated,
    cost: row.cost,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    agent: row.agent,
    model: modelDetails(row.model),
    preview: String(latest.text || '').slice(0, 240),
  };
  if (options.withMessages) {
    const limit = options.limit || 30;
    const offset = options.offset || 0;
    const rows = qMessages.all(row.id, limit, offset).reverse();
    const messageTotal = Number(qMessageCount.get(row.id)?.total || 0);
    result.messages = parseMessages(rows, row.id);
    result.messageOffset = offset;
    result.messageTotal = messageTotal;
    result.hasMoreMessages = offset + rows.length < messageTotal;
  }
  return result;
}

function parseOpencodeRows(rows) {
  if (!rows.length) return [];
  if (previewCache.size + rows.length > 1000) previewCache.clear();
  for (const row of rows) {
    const cached = previewCache.get(row.id);
    if (cached?.updated === row.updated) continue;
    previewCache.set(row.id, { updated: row.updated, data: qLatestText.get(row.id)?.data || '{}' });
  }
  return rows.map((row) => parseOpencodeRow(row, { latestText: previewCache.get(row.id)?.data || '{}' }));
}

function availableDirectories() {
  const dirs = [{ name: 'Home workspace', directory: HOME }];
  let entries = [];
  try {
    entries = readdirSync(PROJECTS, { withFileTypes: true });
  } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(PROJECTS, entry.name);
    try {
      const real = path.resolve(directory);
      if (real === directory && statSyncDirectory(real)) dirs.push({ name: entry.name, directory });
    } catch {}
  }
  return dirs;
}

function statSyncDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function validDirectory(value) {
  const candidate = path.resolve(typeof value === 'string' && value ? value : HOME);
  const allowed = availableDirectories().some((item) => item.directory === candidate);
  if (!allowed) throw Object.assign(new Error('Choose a known workspace directory.'), { status: 400 });
  return candidate;
}

function runHerdr(args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(HERDR, args, {
      cwd: HOME,
      env: { ...process.env, HOME, HERDR_ENV: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) child.kill('SIGKILL');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 200_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) return reject(Object.assign(new Error('Herdr command timed out.'), { status: 504 }));
      if (code !== 0) {
        const detail = stderr.trim();
        const parsed = parseJson(detail);
        const message = parsed?.error?.message || parsed?.message || detail || `Herdr exited (${signal || code}).`;
        return reject(Object.assign(new Error(message), { status: 409 }));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function runSystemCommand(command, args, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: HOME,
      env: { ...process.env, HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 64_000) child.kill('SIGKILL');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64_000) child.kill('SIGKILL');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (timedOut) return reject(Object.assign(new Error(`${path.basename(command)} timed out.`), { status: 504 }));
      resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function resumeUnitName(sessionId) {
  const suffix = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return `workbench-resume-${suffix}.service`;
}

async function savedSessionRunStatus(sessionId) {
  try {
    const result = await runSystemCommand(SYSTEMCTL, ['--user', 'is-active', resumeUnitName(sessionId)], 2500);
    const state = result.stdout.trim();
    if (['active', 'activating', 'deactivating', 'reloading'].includes(state)) return 'working';
    if (['inactive', 'failed', 'maintenance', 'not-found'].includes(state)) return 'idle';
    return result.code === 0 ? 'idle' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function sessionCanResume(row) {
  return Boolean(resumableDirectory(row.directory));
}

function resumableDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim()) return null;
  try {
    const real = realpathSync(path.resolve(directory));
    if (!statSyncDirectory(real)) return null;
    if (real === HOME || real === PROJECTS || real.startsWith(`${PROJECTS}${path.sep}`)) return real;
  } catch {}
  return null;
}

async function herdrSnapshot() {
  const { stdout } = await runHerdr(['api', 'snapshot']);
  const parsed = parseJson(stdout);
  const snapshot = parsed?.result?.snapshot || parsed?.snapshot;
  if (!snapshot) throw new Error('Could not read Herdr state.');
  return snapshot;
}

function getAgentIndex(snapshot) {
  return new Map((snapshot.agents || []).map((agent) => [agent.pane_id, agent]));
}

function systemStats() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    load: os.loadavg().map((x) => Number(x.toFixed(2))),
    cpuCount: os.cpus().length,
    memoryTotal: total,
    memoryFree: free,
    memoryUsed: total - free,
    memoryPercent: Math.round(((total - free) / total) * 100),
    swap: readSwap(),
    uptime: os.uptime(),
  };
}

function readSwap() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(text?.match(/^SwapTotal:\s+(\d+)/m)?.[1] || 0) * 1024;
    const free = Number(text?.match(/^SwapFree:\s+(\d+)/m)?.[1] || 0) * 1024;
    return { total, free, used: total - free };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

async function directLogin(req, res) {
  if (!WORKBENCH_LOGIN_KEY || !WORKBENCH_SESSION_SECRET) {
    return json(res, 503, { error: 'Workbench login is not configured.' });
  }
  let password;
  try {
    password = await readFormPassword(req);
  } catch (error) {
    return json(res, error.status || 400, { error: error.message || 'Invalid login form.' });
  }
  const validPassword = matchesWorkbenchKey(password);
  const attempt = await recordLoginAttempt(req.socket.remoteAddress || 'tailnet', validPassword);
  if (!attempt.allowed) {
    if (await serveStatic(req, res, '/login.html', 429, {
      'Retry-After': String(attempt.retryAfter || 60),
      'Cache-Control': 'no-store',
    })) return;
    return json(res, 429, { error: 'Too many incorrect keys. Wait before trying again.' });
  }
  if (!validPassword) {
    res.writeHead(303, { Location: '/login?error=1', 'Cache-Control': 'no-store' });
    return res.end();
  }
  res.writeHead(303, {
    Location: '/',
    'Set-Cookie': workbenchSessionCookie(newWorkbenchSession()),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  return res.end();
}

async function readRequestBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = parseJson(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
  return body;
}

async function readFormPassword(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw Object.assign(new Error('Expected a form submission.'), { status: 415 });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) throw Object.assign(new Error('Login form is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return String(form.get('password') || '');
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const forwardedHost = req.headers['x-forwarded-host'];
    const expectedHost = String(forwardedHost || req.headers.host || '').split(',')[0].trim().toLowerCase();
    return new URL(origin).host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function proxyKeyMatches(value) {
  if (!INTERNAL_PROXY_KEY || typeof value !== 'string') return false;
  const received = Buffer.from(value);
  const expected = Buffer.from(INTERNAL_PROXY_KEY);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function matchesWorkbenchKey(candidate) {
  if (!WORKBENCH_LOGIN_KEY || typeof candidate !== 'string' || candidate.length > 256) return false;
  const normalizedCandidate = candidate.replace(/[\s-]/g, '').toLowerCase();
  const normalizedExpected = String(WORKBENCH_LOGIN_KEY).replace(/[\s-]/g, '').toLowerCase();
  const candidateHash = createHash('sha256').update(normalizedCandidate).digest();
  const expectedHash = createHash('sha256').update(normalizedExpected).digest();
  const sameHash = timingSafeEqual(candidateHash, expectedHash);
  return sameHash && normalizedCandidate.length === normalizedExpected.length;
}

function requestCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const equals = part.indexOf('=');
    if (equals >= 0 && part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim();
  }
  return '';
}

function hasWorkbenchSession(req) {
  if (!WORKBENCH_SESSION_SECRET) return false;
  const token = requestCookie(req, 'workbench_session');
  if (!token || token.length > 512) return false;
  const [expires, nonce, signature, extra] = token.split('.');
  if (!expires || !/^\d+$/.test(expires) || !nonce || !signature || extra !== undefined) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(nonce) || !/^[A-Za-z0-9_-]+$/.test(signature)) return false;
  const expiry = Number(expires);
  if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000)) return false;
  const expected = createHmac('sha256', WORKBENCH_SESSION_SECRET).update(`${expires}.${nonce}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function newWorkbenchSession() {
  if (!WORKBENCH_SESSION_SECRET) throw new Error('Login protection is not configured.');
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const nonce = randomBytes(18).toString('base64url');
  const payload = `${expires}.${nonce}`;
  const signature = createHmac('sha256', WORKBENCH_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function workbenchSessionCookie(value, maxAge = SESSION_TTL) {
  return `workbench_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function loadLoginFailures() {
  try {
    const saved = JSON.parse(await readFile(LOGIN_FAILURES_FILE, 'utf8'));
    if (!Array.isArray(saved)) throw new Error('Invalid login failure state.');
    const now = Date.now();
    for (const item of saved) {
      if (!Array.isArray(item) || item.length !== 2) continue;
      const [ip, value] = item;
      if (typeof ip !== 'string' || !ip || ip.length > 80 || !value || typeof value !== 'object') continue;
      const failures = Number(value.failures);
      const windowEnds = Number(value.windowEnds);
      const lockedUntil = Number(value.lockedUntil || 0);
      if (!Number.isSafeInteger(failures) || failures < 1 || !Number.isFinite(windowEnds) || !Number.isFinite(lockedUntil)) continue;
      if (windowEnds <= now && lockedUntil <= now) continue;
      loginFailures.set(ip, { failures: Math.min(LOGIN_FAILURE_LIMIT, failures), windowEnds, lockedUntil });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Ignoring unreadable Workbench login-rate state.');
  }
}

async function persistLoginFailures() {
  const write = loginPersistQueue.then(async () => {
    const temporary = path.join(DATA, `login-failures-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify([...loginFailures.entries()]), { mode: 0o600 });
      await rename(temporary, LOGIN_FAILURES_FILE);
    } catch {
      await unlink(temporary).catch(() => {});
      throw Object.assign(new Error('Could not persist login protection state.'), { status: 503 });
    }
  });
  loginPersistQueue = write.then(() => undefined, () => undefined);
  return write;
}

async function recordLoginAttempt(clientIp, success) {
  const key = String(clientIp || 'unknown').slice(0, 80);
  const now = Date.now();
  let record = loginFailures.get(key);
  if (record?.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((record.lockedUntil - now) / 1000)) };
  }
  if (!record || record.windowEnds <= now || record.lockedUntil) {
    record = { failures: 0, windowEnds: now + LOGIN_FAILURE_WINDOW_MS, lockedUntil: 0 };
  }
  if (success) {
    loginFailures.delete(key);
    await persistLoginFailures();
    return { allowed: true, remaining: LOGIN_FAILURE_LIMIT };
  }
  record.failures += 1;
  if (record.failures >= LOGIN_FAILURE_LIMIT) {
    record.lockedUntil = now + LOGIN_FAILURE_WINDOW_MS;
    record.windowEnds = record.lockedUntil;
    loginFailures.set(key, record);
    await persistLoginFailures();
    return { allowed: false, retryAfter: 60 };
  }
  loginFailures.set(key, record);
  if (loginFailures.size > 2048) {
    for (const [ip, entry] of loginFailures) {
      if (entry.windowEnds <= now && entry.lockedUntil <= now) loginFailures.delete(ip);
    }
  }
  await persistLoginFailures();
  return { allowed: true, remaining: LOGIN_FAILURE_LIMIT - record.failures };
}

async function readClips() {
  let text;
  try {
    text = await readFile(path.join(DATA, 'clips.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw Object.assign(new Error('Could not read the clipboard store.'), { status: 503 });
  }
  const data = parseJson(text);
  if (!Array.isArray(data)) throw Object.assign(new Error('Clipboard store is invalid; refusing to overwrite it.'), { status: 503 });
  return data;
}

async function saveClips(clips) {
  if (clips.length > MAX_CLIPS) throw Object.assign(new Error(`Clipboard is full. Keep up to ${MAX_CLIPS} items and delete one before adding another.`), { status: 409 });
  const temp = path.join(DATA, `clips-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(clips), { mode: 0o600 });
    await rename(temp, path.join(DATA, 'clips.json'));
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function withClipMutation(operation) {
  const result = clipMutationQueue.then(operation, operation);
  clipMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function removeClipImage(clip) {
  if (clip?.kind === 'image' && /^[a-z0-9-]+\.(?:png|jpg|webp|gif)$/.test(clip.filename || '')) {
    await unlink(path.join(CLIPS, clip.filename)).catch(() => {});
  }
}

async function pruneClipFiles() {
  let referenced;
  try {
    const clips = await readClips();
    referenced = new Set(clips.filter((clip) => clip.kind === 'image').map((clip) => clip.filename));
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of await readdir(CLIPS, { withFileTypes: true })) {
    if (!entry.isFile() || !/^clip-[a-f0-9-]+\.(?:png|jpg|webp|gif)$/.test(entry.name) || referenced.has(entry.name)) continue;
    const filePath = path.join(CLIPS, entry.name);
    try {
      if ((await stat(filePath)).mtimeMs < cutoff) await unlink(filePath);
    } catch {}
  }
}

function imageData(dataUrl) {
  if (typeof dataUrl !== 'string') throw Object.assign(new Error('Image data is missing.'), { status: 400 });
  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw Object.assign(new Error('Use a PNG, JPEG, WebP, or GIF image.'), { status: 415 });
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE) throw Object.assign(new Error('Each image must be 5 MB or smaller.'), { status: 413 });
  return { mime, buffer };
}

async function storeImage(dataUrl, prefix) {
  const { mime, buffer } = imageData(dataUrl);
  const id = randomUUID();
  const ext = MIME_EXT.get(mime);
  const file = `${prefix}-${id}.${ext}`;
  const base = prefix === 'clip' ? CLIPS : INBOX;
  await writeFile(path.join(base, file), buffer, { mode: 0o600, flag: 'wx' });
  return { id, filename: file, mime, size: buffer.length };
}

function agentView(agent, sessions) {
  const sessionId = agent.agent_session?.value || null;
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : null;
  return {
    paneId: agent.pane_id,
    tabId: agent.tab_id,
    workspaceId: agent.workspace_id,
    agent: agent.agent,
    status: agent.agent_status || 'unknown',
    title: agent.terminal_title_stripped || agent.terminal_title || agent.agent,
    cwd: agent.cwd || agent.foreground_cwd,
    sessionId,
    sessionTitle: session?.title || null,
    updated: session?.updated || null,
  };
}

async function overview() {
  const dirs = availableDirectories();
  const sessions = parseOpencodeRows(qSessions.all(300));
  const snapshot = await herdrSnapshot();
  const agents = (snapshot.agents || []).map((agent) => agentView(agent, sessions));
  const liveIds = new Set(agents.map((agent) => agent.sessionId).filter(Boolean));
  const history = sessions.map((session) => ({
    ...session,
    live: liveIds.has(session.id),
    status: agents.find((agent) => agent.sessionId === session.id)?.status || 'history',
  }));
  return { system: systemStats(), agents, sessions: history, directories: dirs };
}

function sessionHistory(query, directory, offset, limit) {
  const filters = [];
  const values = [];
  if (directory) {
    filters.push('s.directory = ?');
    values.push(directory);
  }
  if (query) {
    const latestText = `(SELECT json_extract(p.data, '$.text')
      FROM part p JOIN message m ON m.id = p.message_id
      WHERE p.session_id = s.id AND json_extract(p.data, '$.type') = 'text'
      ORDER BY m.time_created DESC, p.time_created DESC LIMIT 1)`;
    filters.push(`(
      instr(lower(coalesce(s.title, '')), ?) > 0
      OR instr(lower(coalesce(s.directory, '')), ?) > 0
      OR instr(lower(substr(coalesce(${latestText}, ''), 1, 240)), ?) > 0
    )`);
    values.push(query, query, query);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const count = opencodeDb.prepare(`SELECT COUNT(*) AS total FROM session s ${where}`).get(...values);
  const rows = opencodeDb.prepare(`
    SELECT s.id, s.title, s.directory, s.parent_id AS parentID,
           s.time_created AS created, s.time_updated AS updated,
           s.time_archived AS archived, s.cost,
           s.tokens_input AS inputTokens, s.tokens_output AS outputTokens,
           s.agent, s.model
    FROM session s
    ${where}
    ORDER BY s.time_updated DESC, s.id DESC
    LIMIT ? OFFSET ?
  `).all(...values, limit, offset);
  return { sessions: parseOpencodeRows(rows), total: Number(count?.total || 0) };
}

async function serveStatic(req, res, pathname, status = 200, extraHeaders = {}) {
  const pathMap = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/login', 'login.html'],
    ['/login.html', 'login.html'],
    ['/login.css', 'login.css'],
    ['/login.js', 'login.js'],
    ['/app.js', 'app.js'],
    ['/app.css', 'app.css'],
    ['/sw.js', 'sw.js'],
    ['/manifest.webmanifest', 'manifest.webmanifest'],
    ['/icon.svg', 'icon.svg'],
    ['/fonts/inter.css', 'fonts/inter.css'],
    ['/fonts/inter-latin-wght-normal.woff2', 'fonts/inter-latin-wght-normal.woff2'],
    ['/fonts/inter-latin-ext-wght-normal.woff2', 'fonts/inter-latin-ext-wght-normal.woff2'],
  ]);
  let file = pathMap.get(pathname);
  if (!file && pathname.startsWith('/assets/')) {
    const assetName = pathname.slice('/assets/'.length);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetName)) file = path.join('assets', assetName);
  }
  if (!file) return false;
  const publicRoot = path.resolve(ROOT, 'public');
  const filePath = path.resolve(publicRoot, file);
  if (!filePath.startsWith(`${publicRoot}${path.sep}`)) return false;
  try {
    await access(filePath, fsConstants.R_OK);
    const contents = await readFile(filePath);
    const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css') ? 'text/css; charset=utf-8'
      : file.endsWith('.webmanifest') ? 'application/manifest+json; charset=utf-8'
      : file.endsWith('.svg') ? 'image/svg+xml'
      : file.endsWith('.woff2') ? 'font/woff2'
      : 'text/html; charset=utf-8';
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': contents.length,
      'Cache-Control': file.startsWith(`assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : ['index.html', 'login.html', 'login.css', 'login.js', 'app.js', 'app.css', 'sw.js', 'manifest.webmanifest', 'fonts/inter.css'].includes(file) ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(contents);
    return true;
  } catch {
    return false;
  }
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: 'Invalid URL path.' });
  }
  if (req.method === 'POST' || req.method === 'DELETE') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request blocked.' });
  }

  const trustedProxy = proxyKeyMatches(req.headers['x-workbench-internal-key']);
  if (pathname === '/api/internal/login-attempt' && req.method === 'POST') {
    if (!INTERNAL_PROXY_KEY) return json(res, 503, { error: 'Login protection is not configured.' });
    if (!trustedProxy) return json(res, 403, { error: 'Forbidden.' });
    try {
      const body = await readRequestBody(req);
      if (typeof body.success !== 'boolean') return json(res, 400, { error: 'Invalid login attempt.' });
      return json(res, 200, await recordLoginAttempt(body.ip, body.success));
    } catch (error) {
      return json(res, error.status || 400, { error: error.message || 'Invalid login attempt.' });
    }
  }

  if (!trustedProxy && pathname === '/auth/login' && req.method === 'POST') return directLogin(req, res);
  if (!trustedProxy && pathname === '/logout' && req.method === 'GET') {
    res.writeHead(303, {
      Location: '/login',
      'Set-Cookie': workbenchSessionCookie('', 0),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  const publicLoginAsset = ['GET', 'HEAD'].includes(req.method) && PUBLIC_LOGIN_PATHS.has(pathname);
  if (!trustedProxy && !publicLoginAsset && !hasWorkbenchSession(req)) {
    if (pathname.startsWith('/api/')) return json(res, 401, { error: 'Sign in to Workbench.' });
    res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, POST, DELETE, OPTIONS' });
    return res.end();
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, app: 'Workbench', ...systemStats() });
  }
  if (pathname === '/logout' && req.method === 'GET') {
    res.writeHead(303, {
      Location: '/login',
      'Set-Cookie': workbenchSessionCookie('', 0),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  if (pathname === '/api/overview' && req.method === 'GET') {
    try {
      return json(res, 200, await overview());
    } catch (error) {
      return json(res, error.status || 503, { error: error.message || 'Could not load live agent state.' });
    }
  }
  if (pathname === '/api/sessions' && req.method === 'GET') {
    const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const directory = String(url.searchParams.get('directory') || '');
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Number(url.searchParams.get('limit') || 100);
    const directories = availableDirectories();
    if (query.length > 200) return json(res, 400, { error: 'Search must be 200 characters or fewer.' });
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return json(res, 400, { error: 'Invalid history offset.' });
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json(res, 400, { error: 'History page size must be between 1 and 100.' });
    if (directory && !directories.some((item) => item.directory === directory)) return json(res, 400, { error: 'Choose a known project directory.' });
    try {
      return json(res, 200, { ...sessionHistory(query, directory, offset, limit), offset, limit, directories });
    } catch (error) {
      return json(res, error.status || 503, { error: error.message || 'Could not load history.' });
    }
  }
  const sessionUpdatesMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/updates$/.exec(pathname);
  if (sessionUpdatesMatch && req.method === 'GET') {
    const row = qSession.get(sessionUpdatesMatch[1]);
    if (!row) return json(res, 404, { error: 'Session not found.' });
    const since = url.searchParams.get('since');
    if (since !== null && !/^\d{1,20}$/.test(since)) return json(res, 400, { error: 'Invalid session revision.' });
    const updated = String(row.updated || 0);
    const resumeStatus = await savedSessionRunStatus(row.id);
    if (since === updated) return json(res, 200, { changed: false, updated, resumeStatus });
    const messageRows = qMessages.all(row.id, MESSAGE_UPDATE_SIZE, 0).reverse();
    const messageTotal = Number(qMessageCount.get(row.id)?.total || 0);
    const session = parseOpencodeRow(row);
    session.canResume = sessionCanResume(row);
    session.resumeStatus = resumeStatus;
    session.messages = parseMessages(messageRows, row.id);
    session.messageTotal = messageTotal;
    session.hasMoreMessages = messageRows.length < messageTotal;
    return json(res, 200, { changed: true, updated, session });
  }
  const savedSessionPromptMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/prompt$/.exec(pathname);
  if (savedSessionPromptMatch && req.method === 'POST') {
    const sessionId = savedSessionPromptMatch[1];
    const row = qSession.get(sessionId);
    if (!row) return json(res, 404, { error: 'Session not found.' });
    const directory = resumableDirectory(row.directory);
    if (!directory) return json(res, 409, { error: 'This project folder is no longer available. Start a new task in an active project.' });
    if (savedSessionStarts.has(sessionId)) return json(res, 409, { error: 'A message is already being submitted to this conversation.' });
    savedSessionStarts.add(sessionId);
    const savedImages = [];
    let started = false;
    try {
      const body = await readRequestBody(req);
      let text = typeof body.text === 'string' ? body.text : '';
      if (text.length > 60_000) return json(res, 413, { error: 'Message must be under 60,000 characters.' });
      const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
      if (!text.trim() && !images.length) return json(res, 400, { error: 'Write a message or attach an image.' });
      if (Number(os.freemem()) < AGENT_START_MEMORY) {
        return json(res, 409, { error: 'Low memory: finish or close an agent before resuming this conversation.', system: systemStats() });
      }
      if (await savedSessionRunStatus(sessionId) === 'working') {
        return json(res, 409, { error: 'This saved conversation is already running.' });
      }
      for (const image of images) savedImages.push(await storeImage(image.dataUrl, 'inbox'));
      const runArgs = [
        '--user',
        '--quiet',
        '--collect',
        `--unit=${resumeUnitName(sessionId)}`,
        '--description=Workbench saved-session continuation',
        `--working-directory=${directory}`,
        '--property=MemoryMax=1G',
        '--property=CPUWeight=70',
        '--property=Nice=5',
        '--property=RuntimeMaxSec=7200',
        '--property=StandardOutput=null',
        '--property=StandardError=null',
        `--setenv=HOME=${HOME}`,
        `--setenv=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
        '--',
        OPENCODE_CLI,
        'run',
        '--session',
        sessionId,
        '--dir',
        directory,
        ...savedImages.flatMap((image) => ['--file', path.join(INBOX, image.filename)]),
        '--',
        text,
      ];
      const launch = await runSystemCommand(SYSTEMD_RUN, runArgs, 10_000);
      if (launch.code !== 0) {
        throw Object.assign(new Error(launch.stderr || 'Could not start the saved conversation.'), { status: 503 });
      }
      started = true;
      return json(res, 202, { submitted: true, sessionId, resumed: true, resumeStatus: 'working' });
    } catch (error) {
      if (!started && savedImages.length) {
        await Promise.all(savedImages.map((image) => unlink(path.join(INBOX, image.filename)).catch(() => {})));
      }
      return json(res, error.status || 503, { error: error.message || 'Could not resume this conversation.' });
    } finally {
      savedSessionStarts.delete(sessionId);
    }
  }
  const savedSessionStopMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/stop$/.exec(pathname);
  if (savedSessionStopMatch && req.method === 'POST') {
    const sessionId = savedSessionStopMatch[1];
    if (await savedSessionRunStatus(sessionId) !== 'working') return json(res, 200, { stopped: false });
    const result = await runSystemCommand(SYSTEMCTL, ['--user', 'stop', resumeUnitName(sessionId)], 5000);
    if (result.code !== 0) return json(res, 503, { error: result.stderr || 'Could not stop the saved-session run.' });
    return json(res, 200, { stopped: true });
  }
  const sessionMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (sessionMatch && req.method === 'GET') {
    const row = qSession.get(sessionMatch[1]);
    if (!row) return json(res, 404, { error: 'Session not found.' });
    const before = url.searchParams.get('before');
    if (before !== null) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(before)) return json(res, 400, { error: 'Invalid message cursor.' });
      const cursor = qMessageCursor.get(sessionMatch[1], before);
      if (!cursor) return json(res, 404, { error: 'Message cursor not found.' });
      const rows = qMessagesBefore.all(sessionMatch[1], cursor.created, cursor.created, cursor.id, MESSAGE_PAGE_SIZE).reverse();
      const olderCount = Number(qMessagesBeforeCount.get(sessionMatch[1], cursor.created, cursor.created, cursor.id)?.total || 0);
      const session = parseOpencodeRow(row);
      session.canResume = sessionCanResume(row);
      session.messages = parseMessages(rows, row.id);
      session.messageTotal = Number(qMessageCount.get(row.id)?.total || 0);
      session.hasMoreMessages = olderCount > rows.length;
      return json(res, 200, { session });
    }
    const messageOffset = Number(url.searchParams.get('offset') || 0);
    const messageLimit = Number(url.searchParams.get('limit') || MESSAGE_PAGE_SIZE);
    if (!Number.isSafeInteger(messageOffset) || messageOffset < 0 || messageOffset > 1_000_000) return json(res, 400, { error: 'Invalid message offset.' });
    if (!Number.isSafeInteger(messageLimit) || messageLimit < 1 || messageLimit > 100) return json(res, 400, { error: 'Message page size must be between 1 and 100.' });
    const session = parseOpencodeRow(row, { withMessages: true, offset: messageOffset, limit: messageLimit });
    session.canResume = sessionCanResume(row);
    session.resumeStatus = await savedSessionRunStatus(row.id);
    return json(res, 200, { session });
  }
  const sessionFileMatch = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/files\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (sessionFileMatch && req.method === 'GET') {
    const row = qFilePart.get(sessionFileMatch[2], sessionFileMatch[1]);
    const part = row ? parseDbJson(row.data) : null;
    if (!part || part.type !== 'file' || !String(part.mime || '').startsWith('image/')) return json(res, 404, { error: 'Image not found.' });
    try {
      const image = imageData(part.url);
      res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.buffer.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
      return res.end(image.buffer);
    } catch {
      return json(res, 404, { error: 'Image is no longer available.' });
    }
  }
  if (pathname === '/api/agents' && req.method === 'GET') {
    try {
      const sessions = parseOpencodeRows(qSessions.all(300));
      const snapshot = await herdrSnapshot();
      return json(res, 200, { agents: (snapshot.agents || []).map((agent) => agentView(agent, sessions)), system: systemStats() });
    } catch (error) {
      return json(res, error.status || 503, { error: error.message || 'Could not read Herdr state.' });
    }
  }
  const outputMatch = /^\/api\/agents\/([^/]+)\/output$/.exec(pathname);
  if (outputMatch && req.method === 'GET') {
    const paneId = decodeURIComponent(outputMatch[1]);
    if (!/^[A-Za-z0-9_-]+:p\d+$/.test(paneId)) return json(res, 400, { error: 'Invalid pane.' });
    try {
      const snapshot = await herdrSnapshot();
      if (!getAgentIndex(snapshot).has(paneId)) return json(res, 404, { error: 'Agent is no longer active.' });
      const liveAgent = getAgentIndex(snapshot).get(paneId);
      const source = ['working', 'blocked'].includes(liveAgent.agent_status) ? 'visible' : 'recent-unwrapped';
      const lines = source === 'visible' ? '36' : '90';
      const result = await runHerdr(['agent', 'read', paneId, '--source', source, '--lines', lines]);
      return json(res, 200, { output: result.stdout });
    } catch (error) {
      return json(res, error.status || 503, { error: error.message });
    }
  }
  const promptMatch = /^\/api\/agents\/([^/]+)\/prompt$/.exec(pathname);
  if (promptMatch && req.method === 'POST') {
    const paneId = decodeURIComponent(promptMatch[1]);
    if (!/^[A-Za-z0-9_-]+:p\d+$/.test(paneId)) return json(res, 400, { error: 'Invalid pane.' });
    try {
      const body = await readRequestBody(req);
      let text = typeof body.text === 'string' ? body.text : '';
      if (text.length > 60_000) return json(res, 413, { error: 'Message must be under 60,000 characters.' });
      const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
      if (!text.trim() && !images.length) return json(res, 400, { error: 'Write a message or attach an image.' });
      const snapshot = await herdrSnapshot();
      const agent = getAgentIndex(snapshot).get(paneId);
      if (!agent) return json(res, 404, { error: 'Agent is no longer active.' });
      if (agent.agent_status === 'blocked') return json(res, 409, { error: 'This agent is waiting for approval. Review the terminal before continuing.' });
      const savedImages = [];
      try {
        for (const image of images) savedImages.push(await storeImage(image.dataUrl, 'inbox'));
      } catch (error) {
        await Promise.all(savedImages.map((saved) => unlink(path.join(INBOX, saved.filename)).catch(() => {})));
        throw error;
      }
      const paths = savedImages.map((saved) => path.join(INBOX, saved.filename));
      if (paths.length) {
        const note = `Attached image${paths.length === 1 ? '' : 's'} saved on the VPS:\n${paths.map((file) => `- ${file}`).join('\n')}\nPlease inspect ${paths.length === 1 ? 'it' : 'them'} as part of this task.`;
        text = text.trim() ? `${text}\n\n${note}` : note;
      }
      // Submit without --wait: the UI polls the session for the agent response.
      // Keep one outer bound instead of a shorter nested Herdr timeout.
      await runHerdr(['agent', 'prompt', paneId, text], 25000);
      return json(res, 202, { submitted: true, paneId, attachedImages: paths.length });
    } catch (error) {
      const message = error.status === 504
        ? 'Prompt submission timed out. Check the live output before retrying to avoid sending it twice.'
        : error.message || 'Could not submit message.';
      return json(res, error.status || 503, { error: message });
    }
  }
  const interruptMatch = /^\/api\/agents\/([^/]+)\/interrupt$/.exec(pathname);
  if (interruptMatch && req.method === 'POST') {
    const paneId = decodeURIComponent(interruptMatch[1]);
    if (!/^[A-Za-z0-9_-]+:p\d+$/.test(paneId)) return json(res, 400, { error: 'Invalid pane.' });
    try {
      const snapshot = await herdrSnapshot();
      if (!getAgentIndex(snapshot).has(paneId)) return json(res, 404, { error: 'Agent is no longer active.' });
      await runHerdr(['agent', 'send-keys', paneId, 'ctrl+c'], 5000);
      return json(res, 200, { interrupted: true });
    } catch (error) {
      return json(res, error.status || 503, { error: error.message });
    }
  }
  if (pathname === '/api/tasks' && req.method === 'POST') {
    if (taskStartInProgress) return json(res, 409, { error: 'Another task is being started. Try again in a moment.' });
    taskStartInProgress = true;
    try {
      const stats = systemStats();
      if (stats.memoryFree < AGENT_START_MEMORY) return json(res, 409, { error: 'Low memory: finish or close an agent before starting another.', system: stats });
      const body = await readRequestBody(req);
      const directory = validDirectory(body.directory);
      const prompt = String(body.prompt || '');
      const promptText = prompt.trim();
      const title = String(body.title || promptText.slice(0, 54) || 'New task').trim().slice(0, 70);
      if (!promptText) return json(res, 400, { error: 'Add a task description first.' });
      const kind = body.kind === 'pi' ? 'pi' : 'opencode';
      const label = `Workbench · ${title}`;
      const created = await runHerdr(['workspace', 'create', '--cwd', directory, '--label', label, '--no-focus'], 15000);
      const result = parseJson(created.stdout)?.result;
      const workspaceId = result?.workspace_id || result?.workspace?.id || result?.root_pane?.workspace_id;
      const paneId = result?.root_pane?.pane_id;
      if (!paneId) {
        if (workspaceId) await runHerdr(['workspace', 'close', String(workspaceId)], 8000).catch(() => {});
        throw new Error('Herdr did not return a new workspace pane.');
      }
      const name = `web-${randomUUID().slice(0, 8)}`;
      try {
        await runHerdr(['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', '45000'], 50000);
      } catch (error) {
        if (workspaceId) await runHerdr(['workspace', 'close', String(workspaceId)], 8000).catch(() => {});
        throw error;
      }
      try {
        // Submit only; the UI refreshes the agent state asynchronously.
        await runHerdr(['agent', 'prompt', name, prompt], 25000);
      } catch (error) {
        return json(res, 202, {
          started: true,
          promptSubmitted: false,
          paneId,
          name,
          kind,
          directory,
          title,
          warning: 'The agent started, but Workbench could not confirm the first message. Check its output before resending.',
        });
      }
      return json(res, 201, { started: true, paneId, name, kind, directory, title });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Could not start the task.' });
    } finally {
      taskStartInProgress = false;
    }
  }
  if (pathname === '/api/clips' && req.method === 'GET') {
    const clips = await readClips();
    return json(res, 200, { clips });
  }
  if (pathname === '/api/clips' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const device = String(body.device || 'This device').slice(0, 40);
      if (body.kind === 'image') {
        let saved;
        let clip;
        try {
          await withClipMutation(async () => {
            const clips = await readClips();
            if (clips.length >= MAX_CLIPS) throw Object.assign(new Error(`Clipboard is full. Delete an item before adding another (limit ${MAX_CLIPS}).`), { status: 409 });
            saved = await storeImage(body.dataUrl, 'clip');
            clip = { id: saved.id, kind: 'image', device, mime: saved.mime, filename: saved.filename, size: saved.size, created: Date.now() };
            await saveClips([clip, ...clips]);
          });
        } catch (error) {
          if (saved) await removeClipImage({ kind: 'image', filename: saved.filename });
          throw error;
        }
        return json(res, 201, { clip });
      }
      const text = typeof body.text === 'string' ? body.text : '';
      if (text.length > 50_000) return json(res, 413, { error: 'Clipboard text must be 50,000 characters or fewer.' });
      if (!text.trim()) return json(res, 400, { error: 'Add text to the clip first.' });
      const clip = { id: randomUUID(), kind: 'text', device, text, created: Date.now() };
      await withClipMutation(async () => {
        const clips = await readClips();
        if (clips.length >= MAX_CLIPS) throw Object.assign(new Error(`Clipboard is full. Delete an item before adding another (limit ${MAX_CLIPS}).`), { status: 409 });
        await saveClips([clip, ...clips]);
      });
      return json(res, 201, { clip });
    } catch (error) {
      return json(res, error.status || 500, { error: error.message || 'Could not save clip.' });
    }
  }
  const clipDataMatch = /^\/api\/clips\/([A-Za-z0-9-]+)\/data$/.exec(pathname);
  if (clipDataMatch && req.method === 'GET') {
    const clips = await readClips();
    const clip = clips.find((item) => item.id === clipDataMatch[1] && item.kind === 'image');
    if (!clip || !/^[a-z0-9-]+\.(?:png|jpg|webp|gif)$/.test(clip.filename)) return json(res, 404, { error: 'Image clip not found.' });
    try {
      const bytes = await readFile(path.join(CLIPS, clip.filename));
      res.writeHead(200, { 'Content-Type': clip.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' });
      return res.end(bytes);
    } catch {
      return json(res, 404, { error: 'Image file is missing.' });
    }
  }
  const clipMatch = /^\/api\/clips\/([A-Za-z0-9-]+)$/.exec(pathname);
  if (clipMatch && req.method === 'DELETE') {
    let clip;
    await withClipMutation(async () => {
      const clips = await readClips();
      clip = clips.find((item) => item.id === clipMatch[1]);
      if (!clip) throw Object.assign(new Error('Clip not found.'), { status: 404 });
      await saveClips(clips.filter((item) => item.id !== clipMatch[1]));
    });
    await removeClipImage(clip);
    return json(res, 200, { deleted: true });
  }

  if (await serveStatic(req, res, pathname)) return;
  return json(res, 404, { error: 'Not found.' });
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    if (!res.headersSent) json(res, error.status || 500, { error: error.message || 'Internal error.' });
    else res.destroy(error);
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Workbench listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    opencodeDb.close();
    process.exit(0);
  });
});
