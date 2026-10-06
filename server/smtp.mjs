import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { fail } from './store.mjs';

/* Minimal SMTP delivery (PLAN §33, phase 2).

   Design goals: no new dependencies, completely off the run path, disabled by
   default. Configuration lives in `settings.smtp` (or individual `smtp.*`
   keys). Delivery is best-effort: a queue with bounded exponential backoff, and
   every failure is swallowed into `notifications.delivery='failed'` plus a log
   line. A broken mail server can never slow down or fail a run.

   Events that warrant mail are opt-in per kind (`run.failed`, `run.completed`
   only for long tasks, and anything that needs the user to act). If `smtp.host`
   is not configured the whole module is a no-op. */

const DEFAULT_EVENTS = ['run.failed', 'input_required', 'run.completed'];
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const DEFAULT_LONG_TASK_MS = 60000;
const CONNECT_TIMEOUT_MS = 20000;
const RESPONSE_TIMEOUT_MS = 20000;

/* ---- configuration ---- */

function normalizeRecipients(value) {
  const list = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string' ? value.split(/[,;\s]+/) : [];
  return list
    .map((item) => item.trim())
    .filter((item) => item && !/[\r\n]/.test(item))
    .slice(0, 20);
}

/* Accept either one `smtp` object or individual `smtp.host`, `smtp.port`, …
   keys; the object wins field by field. */
export function readSmtpConfig(store) {
  const nested = store.getSetting('smtp', null);
  const base = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {};
  const field = (name) => (base[name] !== undefined && base[name] !== null && base[name] !== ''
    ? base[name]
    : store.getSetting(`smtp.${name}`, undefined));
  const hostCandidate = field('host');
  const host = typeof hostCandidate === 'string' && hostCandidate.trim() ? hostCandidate.trim() : null;
  const rawPort = Number(field('port') || 587);
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? Math.floor(rawPort) : 587;
  const events = Array.isArray(field('events')) ? field('events') : DEFAULT_EVENTS;
  const longTaskMs = Number(field('longTaskMs'));
  const user = field('user');
  const pass = field('pass');
  return {
    host,
    port,
    secure: field('secure') === true || port === 465,
    requireTls: field('requireTls') !== false,
    rejectUnauthorized: field('rejectUnauthorized') !== false,
    user: typeof user === 'string' && user ? user : null,
    pass: typeof pass === 'string' && pass ? pass : null,
    from: typeof field('from') === 'string' && field('from') ? field('from') : (typeof user === 'string' && user ? user : null),
    to: normalizeRecipients(field('to')),
    events: events.filter((kind) => typeof kind === 'string').slice(0, 32),
    longTaskMs: Number.isFinite(longTaskMs) && longTaskMs > 0 ? Math.floor(longTaskMs) : DEFAULT_LONG_TASK_MS,
    enabled: field('enabled') === undefined ? true : field('enabled') !== false,
    helloName: typeof field('helloName') === 'string' && field('helloName') ? field('helloName') : 'workbench.local',
  };
}

/* Safe projection for GET /settings: never leak the password. */
export function publicSmtpConfig(store) {
  const config = readSmtpConfig(store);
  return {
    configured: !!config.host,
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTls: config.requireTls,
    rejectUnauthorized: config.rejectUnauthorized,
    user: config.user,
    from: config.from,
    to: config.to,
    events: config.events,
    longTaskMs: config.longTaskMs,
    hasPassword: !!config.pass,
  };
}

export function validateSmtpInput(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('SMTP settings must be an object.');
  const current = readSmtpConfig(store);
  const pickString = (value, fallback) => (typeof value === 'string' ? value.trim() : fallback);
  const host = input.host === undefined ? current.host : (pickString(input.host, '') || null);
  if (host && (/[\r\n\s]/.test(host))) throw fail('SMTP host must be a single hostname.');
  const rawPort = input.port === undefined ? current.port : Number(input.port);
  if (host && (!Number.isFinite(rawPort) || rawPort <= 0 || rawPort > 65535)) throw fail('SMTP port must be between 1 and 65535.');
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? Math.floor(rawPort) : 587;
  const to = input.to === undefined ? current.to : normalizeRecipients(input.to);
  const events = input.events === undefined ? current.events : (Array.isArray(input.events) ? input.events.filter((kind) => typeof kind === 'string').slice(0, 32) : current.events);
  const longTaskMs = input.longTaskMs === undefined ? current.longTaskMs : (Number(input.longTaskMs) > 0 ? Math.floor(Number(input.longTaskMs)) : DEFAULT_LONG_TASK_MS);
  const pass = input.pass === undefined ? current.pass : (typeof input.pass === 'string' && input.pass ? input.pass : null);
  return {
    host,
    port,
    secure: input.secure === undefined ? current.secure || port === 465 : input.secure === true || port === 465,
    requireTls: input.requireTls === undefined ? current.requireTls : input.requireTls !== false,
    rejectUnauthorized: input.rejectUnauthorized === undefined ? current.rejectUnauthorized : input.rejectUnauthorized !== false,
    user: input.user === undefined ? current.user : (pickString(input.user, '') || null),
    pass,
    from: input.from === undefined ? current.from : (pickString(input.from, '') || null),
    to,
    events,
    longTaskMs,
    enabled: input.enabled === undefined ? current.enabled : input.enabled !== false,
    helloName: input.helloName === undefined ? current.helloName : (pickString(input.helloName, '') || 'workbench.local'),
  };
}

export function saveSmtpConfig(store, input) {
  const config = validateSmtpInput(store, input);
  store.setSetting('smtp', config);
  return publicSmtpConfig(store);
}

/* ---- minimal SMTP client over node:net / node:tls ---- */

function parseResponse(buffer) {
  let offset = 0;
  let text = '';
  while (true) {
    const nl = buffer.indexOf('\n', offset);
    if (nl < 0) return null;
    const line = buffer.slice(offset, nl + 1);
    offset = nl + 1;
    text += line;
    const trimmed = line.replace(/\r?\n$/, '');
    if (/^\d{3}(?: |$)/.test(trimmed)) return { code: Number(trimmed.slice(0, 3)), text, consumed: offset };
  }
}

function makeReader() {
  let socket = null;
  let buffer = '';
  const waiters = [];
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    drain();
  };
  const onError = (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  function drain() {
    while (waiters.length) {
      const parsed = parseResponse(buffer);
      if (!parsed) return;
      buffer = buffer.slice(parsed.consumed);
      waiters.shift().resolve(parsed);
    }
  }
  return {
    attach(next) {
      this.detach();
      socket = next;
      buffer = '';
      socket.on('data', onData);
      socket.on('error', onError);
    },
    detach() {
      if (!socket) return;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket = null;
    },
    next(timeoutMs = RESPONSE_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('SMTP server did not respond in time.'));
        }, timeoutMs);
        timer.unref?.();
        waiter.resolve = (value) => { clearTimeout(timer); resolve(value); };
        waiter.reject = (error) => { clearTimeout(timer); reject(error); };
        waiters.push(waiter);
        drain();
      });
    },
  };
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const options = { host: config.host, port: config.port };
    const socket = config.secure
      ? tls.connect({ ...options, servername: config.host, rejectUnauthorized: config.rejectUnauthorized })
      : net.connect(options);
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    const failSoon = (error) => { socket.destroy(); reject(error); };
    socket.once(config.secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', failSoon);
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', failSoon);
    socket.once('timeout', () => failSoon(new Error('SMTP connection timed out.')));
  });
}

async function command(reader, socket, line, expected) {
  socket.write(`${line}\r\n`);
  const response = await reader.next();
  if (expected && !expected.includes(response.code)) {
    throw new Error(`SMTP ${response.code}: ${response.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  }
  return response;
}

async function upgradeTls(socket, config) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({ socket, servername: config.host, rejectUnauthorized: config.rejectUnauthorized }, () => resolve(secureSocket));
    secureSocket.setTimeout(CONNECT_TIMEOUT_MS, () => { secureSocket.destroy(); reject(new Error('SMTP TLS handshake timed out.')); });
    secureSocket.once('error', reject);
  });
}

function authMechanisms(ehloText) {
  const match = /AUTH[ =-]([^\r\n]*)/i.exec(ehloText);
  return match ? match[1].trim().toUpperCase().split(/\s+/).filter(Boolean) : [];
}

async function authenticate(reader, socket, config, ehloText) {
  if (!config.user) return;
  const mechanisms = authMechanisms(ehloText);
  if (!mechanisms.length || mechanisms.includes('PLAIN')) {
    const token = Buffer.from(`\u0000${config.user}\u0000${config.pass || ''}`, 'utf8').toString('base64');
    try {
      await command(reader, socket, `AUTH PLAIN ${token}`, [235]);
      return;
    } catch (error) {
      if (!mechanisms.includes('LOGIN')) throw error;
    }
  }
  if (mechanisms.includes('LOGIN') || !mechanisms.length) {
    await command(reader, socket, 'AUTH LOGIN', [334]);
    await command(reader, socket, Buffer.from(config.user, 'utf8').toString('base64'), [334]);
    await command(reader, socket, Buffer.from(config.pass || '', 'utf8').toString('base64'), [235]);
    return;
  }
  throw new Error('SMTP server offers no supported authentication mechanism.');
}

function encodeHeader(value) {
  const text = String(value).replace(/[\r\n]+/g, ' ').slice(0, 200);
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value) {
  return value.replace(/(.{76})/g, '$1\r\n');
}

function buildMessage(config, job) {
  const body = [
    job.title || 'Workbench notification',
    '',
    job.body ? String(job.body) : '',
    '',
    `Conversation: ${job.conversationId || 'n/a'}`,
    `Run: ${job.runId || 'n/a'}`,
    '',
    'Sent by Workbench.',
  ].join('\n');
  return [
    `From: ${config.from}`,
    `To: ${config.to.join(', ')}`,
    `Subject: ${encodeHeader(`[Workbench] ${job.title || 'Notification'}`)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@workbench>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(body, 'utf8').toString('base64')),
  ].join('\r\n');
}

async function sendMail(config, job) {
  if (!config.host || !config.from || !config.to.length) throw new Error('SMTP is not fully configured.');
  let socket = await connect(config);
  const reader = makeReader();
  reader.attach(socket);
  try {
    const greeting = await reader.next();
    if (greeting.code !== 220) throw new Error(`SMTP ${greeting.code}: ${greeting.text.trim()}`);
    let ehlo = await command(reader, socket, `EHLO ${config.helloName}`, [250]);
    if (!config.secure) {
      const supportsStartTls = /STARTTLS/i.test(ehlo.text);
      if (supportsStartTls) {
        await command(reader, socket, 'STARTTLS', [220]);
        reader.detach();
        socket = await upgradeTls(socket, config);
        reader.attach(socket);
        ehlo = await command(reader, socket, `EHLO ${config.helloName}`, [250]);
      } else if (config.requireTls) {
        throw new Error('SMTP server does not offer STARTTLS.');
      }
    }
    await authenticate(reader, socket, config, ehlo.text);
    await command(reader, socket, `MAIL FROM:<${config.from}>`, [250]);
    for (const recipient of config.to) await command(reader, socket, `RCPT TO:<${recipient}>`, [250, 251]);
    await command(reader, socket, 'DATA', [354]);
    socket.write(`${buildMessage(config, job)}\r\n.\r\n`);
    const done = await reader.next();
    if (done.code !== 250) throw new Error(`SMTP ${done.code}: ${done.text.trim().slice(0, 300)}`);
    await command(reader, socket, 'QUIT', [221]).catch(() => {});
  } finally {
    reader.detach();
    socket.destroy();
  }
}

/* ---- queue + retry ---- */

function mapEventKind(kind) {
  if (kind === 'run.failed') return 'run.failed';
  if (kind === 'run.completed') return 'run.completed';
  if (kind === 'question.required' || kind === 'permission.required' || kind === 'input_required') return 'input_required';
  return null;
}

export function createSmtpMailer(store, { logger = console } = {}) {
  const queue = [];
  let processing = false;
  let stopped = false;

  const log = (level, message, extra = {}) => {
    try { logger[level]?.(JSON.stringify({ event: 'smtp', message, ...extra })); } catch {}
  };

  function markDelivery(id, status) {
    try { store.db.prepare('UPDATE notifications SET delivery=? WHERE id=?').run(status, id); } catch {}
    try { store.event('notifications.changed', null, { notificationId: id, delivery: status }, { kind: 'notifications.changed' }); } catch {}
  }

  function planFor(event) {
    const config = readSmtpConfig(store);
    if (!config.host || !config.enabled || !config.from || !config.to.length) return null;
    if (!event.notificationId) return null;
    const key = mapEventKind(event.kind);
    if (!key) return null;
    if (!config.events.includes(key) && !config.events.includes(event.kind)) return null;
    const row = store.db.prepare('SELECT * FROM notifications WHERE id=?').get(event.notificationId);
    if (!row) return null;
    if (event.kind === 'run.completed') {
      const run = row.run_id ? store.db.prepare('SELECT started,ended FROM commands WHERE id=?').get(row.run_id) : null;
      const duration = run?.started && run?.ended ? Number(run.ended) - Number(run.started) : 0;
      if (duration < config.longTaskMs) return null;
    }
    return { row, config };
  }

  function enqueue(event) {
    try {
      if (stopped || !event || event.type !== 'notification.created') return;
      const plan = planFor(event);
      if (!plan) return;
      queue.push({
        notificationId: plan.row.id,
        title: plan.row.title,
        body: plan.row.body,
        conversationId: plan.row.conversation_id,
        runId: plan.row.run_id,
        attempts: 0,
      });
      schedule();
    } catch (error) {
      log('warn', 'enqueue failed', { error: error.message });
    }
  }

  function schedule() {
    if (processing || stopped || !queue.length) return;
    setImmediate(process);
  }

  async function process() {
    if (processing || stopped) return;
    processing = true;
    try {
      while (queue.length && !stopped) {
        const job = queue.shift();
        const config = readSmtpConfig(store);
        if (!config.host || !config.enabled) return;
        try {
          await sendMail(config, job);
          job.attempts = 0;
          markDelivery(job.notificationId, 'sent');
          log('log', 'delivered', { notificationId: job.notificationId, to: config.to.length });
        } catch (error) {
          job.attempts += 1;
          markDelivery(job.notificationId, 'failed');
          log('warn', 'delivery failed', { notificationId: job.notificationId, attempt: job.attempts, error: String(error.message || error).slice(0, 300) });
          if (job.attempts < MAX_ATTEMPTS) {
            const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (job.attempts - 1));
            const timer = setTimeout(() => {
              if (stopped) return;
              queue.push(job);
              schedule();
            }, delay);
            timer.unref?.();
          }
        }
      }
    } finally {
      processing = false;
      if (queue.length && !stopped) schedule();
    }
  }

  return {
    enqueue,
    start() { /* listener is wired by the control plane */ },
    stop() { stopped = true; queue.length = 0; },
  };
}
