import { createServer, request as httpRequest } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Workbench gateway: authentication, login rate limiting, the public
   health endpoint and the streaming proxy to the control plane. Agent
   execution, conversations, models and usage live in server/control.mjs. */

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || os.homedir();
const DATA = process.env.WORKBENCH_DATA || path.join(ROOT, 'data');
const LOGIN_FAILURES_FILE = path.join(DATA, 'login-failures.json');
const PORT = Number(process.env.PORT || 8787);
const CONTROL_PORT = Number(process.env.WORKBENCH_CONTROL_PORT || 8788);
const SECRET_FILE = path.join(HOME, '.config/secrets/workbench-cloudflare-secrets.json');
const SESSION_TTL = 14 * 24 * 60 * 60;
const PUBLIC_LOGIN_PATHS = new Set([
  '/login',
  '/login.html',
  '/login.css',
  '/login.js',
  '/fonts/inter.css',
  '/fonts/inter-latin-wght-normal.woff2',
  '/fonts/inter-latin-ext-wght-normal.woff2',
]);

let SECRET_VALUES = {};
try { SECRET_VALUES = JSON.parse(readFileSync(SECRET_FILE, 'utf8')) || {}; } catch {}
const INTERNAL_PROXY_KEY = process.env.WORKBENCH_PROXY_KEY || SECRET_VALUES.WORKBENCH_PROXY_KEY || '';
const WORKBENCH_LOGIN_KEY = process.env.WORKBENCH_LOGIN || SECRET_VALUES.WORKBENCH_LOGIN || '';
const WORKBENCH_SESSION_SECRET = process.env.WORKBENCH_SESSION_SECRET || SECRET_VALUES.WORKBENCH_SESSION_SECRET || '';

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 60_000;

const loginFailures = new Map();
let loginPersistQueue = Promise.resolve();

await mkdir(DATA, { recursive: true, mode: 0o700 });
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

async function readRequestBody(req, max = 4096) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { status: 400 });
  }
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
  /* Browsers set Sec-Fetch-Site themselves and a cross-site initiator can't
     forge it, so when it's present it is the authority. Chromium sends
     `Origin: null` on same-origin form POSTs from pages served with a
     no-referrer policy (the login page), which the header comparison below
     would otherwise reject. */
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'same-origin' || site === 'none') return true;
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
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
    uptime: os.uptime(),
  };
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

async function serveStatic(req, res, pathname, status = 200, extraHeaders = {}) {
  const pathMap = new Map([
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/login', 'login.html'],
    ['/login.html', 'login.html'],
    ['/login.css', 'login.css'],
    ['/login.js', 'login.js'],
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
  const publicRoot = path.resolve(process.env.WORKBENCH_PUBLIC && (file === 'index.html' || file.startsWith('assets/')) ? process.env.WORKBENCH_PUBLIC : path.join(ROOT, 'public'));
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
        : ['index.html', 'login.html', 'login.css', 'login.js', 'sw.js', 'manifest.webmanifest', 'fonts/inter.css'].includes(file) ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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

function proxyToControl(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${CONTROL_PORT}`, 'x-workbench-internal-key': INTERNAL_PROXY_KEY };
  delete headers.cookie;
  delete headers.authorization;
  /* Hop-by-hop headers must not be forwarded; keeping the upstream's
     transfer-encoding or connection header stalls streamed responses. */
  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']) delete headers[name];
  /* Browsers close EventSource connections without a body; the control
     plane sends its own heartbeats, so no proxy-level timeout is added. */
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: CONTROL_PORT,
    path: req.url,
    method: req.method,
    headers,
  }, (response) => {
    const responseHeaders = { ...response.headers };
    for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']) delete responseHeaders[name];
    res.writeHead(response.statusCode || 502, responseHeaders);
    response.pipe(res);
    response.on('error', () => res.destroy());
  });
  upstream.on('error', () => {
    if (!res.headersSent) json(res, 503, { error: 'The conversation service is restarting. Your draft is saved on this device.' });
    else res.destroy();
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: 'Invalid URL path.' });
  }
  if (['POST', 'DELETE', 'PATCH', 'PUT'].includes(req.method) && !sameOrigin(req)) {
    return json(res, 403, { error: 'Cross-origin request blocked.' });
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

  if (pathname.startsWith('/api/v2/')) return proxyToControl(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { Allow: 'GET, HEAD, POST, DELETE, OPTIONS' });
    return res.end();
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, app: 'Workbench', ...systemStats() });
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
  console.log(`Workbench gateway listening on http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
