#!/usr/bin/env node
/*
 * Workbench UI-path end-to-end check.
 *
 * Drives the LIVE stack through the same requests the browser makes: the
 * authenticated gateway (server.js :8787, session cookie) -> /api/v2 -> control,
 * with the SSE stream open, on REAL workspaces (General, HOME) and both engines,
 * in build and plan modes. This is the path that the unit/acceptance suites do
 * NOT exercise, so it catches sandbox/spawn/auth regressions that only show up
 * end to end (e.g. a bubblewrap mask aborting every run).
 *
 * Requires the running services. Exits non-zero on any failure.
 */
import { readFileSync } from 'node:fs';
import { newSession } from '../shared/auth.mjs';

const secrets = JSON.parse(readFileSync(`${process.env.HOME}/.config/secrets/workbench-cloudflare-secrets.json`, 'utf8'));
const token = await newSession(secrets.WORKBENCH_SESSION_SECRET);
const BASE = process.env.WORKBENCH_UI_URL || 'http://127.0.0.1:8787/api/v2';
const ORIGIN = new URL(BASE).origin;
const H = { cookie: `workbench_session=${token}`, 'content-type': 'application/json', origin: ORIGIN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body, method) {
  const r = await fetch(BASE + path, { method: method || (body ? 'POST' : 'GET'), headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const GENERAL = `${process.env.HOME}/.local/share/workbench/control/general`;
const MODEL = process.env.WORKBENCH_UI_MODEL || 'opencode-go/deepseek-v4-flash';
const cases = [
  { name: 'opencode general build', engine: 'opencode', workspace: GENERAL, mode: 'build' },
  { name: 'pi general build', engine: 'pi', workspace: GENERAL, mode: 'build' },
  { name: 'opencode home build', engine: 'opencode', workspace: process.env.HOME, mode: 'build' },
  { name: 'opencode general plan', engine: 'opencode', workspace: GENERAL, mode: 'plan' },
  { name: 'pi home plan', engine: 'pi', workspace: process.env.HOME, mode: 'plan' },
];

let failures = 0;
for (const c of cases) {
  const chatId = `chat_${crypto.randomUUID()}`;
  const word = `E2E_${c.engine.toUpperCase()}_OK`;
  try {
    await api('/conversations', { id: chatId, title: `e2e ${c.name}`, engine: c.engine, workspace: c.workspace, model: MODEL, mode: c.mode });
    const controller = new AbortController();
    let frames = 0, sawDelta = false, sawState = false;
    const sse = (async () => {
      const res = await fetch(`${BASE}/events?after=0`, { headers: { cookie: H.cookie }, signal: controller.signal });
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); frames++; if (chunk.includes('text.delta')) sawDelta = true; if (chunk.includes('run.state')) sawState = true; }
        }
      } catch { /* aborted */ }
    })();
    await api(`/conversations/${chatId}/commands`, { clientCommandId: crypto.randomUUID(), text: `Reply exactly ${word}. Do not use tools.`, attachmentIds: [], model: MODEL });
    let status = 'queued', error = null, reply = false;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const { session } = await api(`/conversations/${chatId}`);
      status = session.status; error = session.activeRun?.error || null;
      reply = (session.messages || []).some((m) => m.info?.role === 'assistant' && (m.parts || []).some((p) => (p.text || '').includes(word)));
      if (status !== 'working') break;
      await sleep(2000);
    }
    controller.abort();
    const pass = reply && !error;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'} ${c.name} :: status=${status} reply=${reply} err=${error} sseFrames=${frames} delta=${sawDelta} state=${sawState}`);
    if (status === 'working') await api(`/conversations/${chatId}/stop`, {}).catch(() => {});
    await api(`/conversations/${chatId}`, undefined, 'DELETE').catch(() => {});
  } catch (error) {
    failures++;
    console.log(`FAIL ${c.name} :: ${error.message}`);
    await api(`/conversations/${chatId}/stop`, {}).catch(() => {});
    await api(`/conversations/${chatId}`, undefined, 'DELETE').catch(() => {});
  }
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL UI-PATH E2E CASES PASS');
process.exit(failures ? 1 : 0);
