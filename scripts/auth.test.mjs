import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { newSession, hasSession, matchesSecret, matchesPassword, sessionCookie, readCookie } from '../shared/auth.mjs';
import alias from '../worker-alias.js';
import worker from '../worker.js';

test('shared session protocol accepts existing Node cookies and rejects tampering/expiry', async () => {
  const key = 'test-signing-key';
  const oldToken = payload => `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
  const payload = `${Math.floor(Date.now() / 1000) + 3600}.nonce`;
  assert.equal(await hasSession(oldToken(payload), key), true);
  assert.equal(await hasSession(oldToken('1.nonce'), key), false);
  assert.equal(await hasSession(oldToken('NaN.nonce'), key), false);
  assert.equal(await hasSession(oldToken(payload) + 'x', key), false);
  const token = await newSession(key);
  assert.equal(await hasSession(readCookie(sessionCookie(token)), key), true);
  assert.equal(await hasSession(token, ''), false);
});

test('internal keys fail closed; only login passwords normalize whitespace/hyphens', async () => {
  assert.equal(await matchesSecret('', ''), false);
  assert.equal(await matchesSecret('secret', 'secret'), true);
  assert.equal(await matchesSecret('secret\0', 'secret'), false);
  assert.equal(await matchesSecret('SECRET', 'secret'), false);
  assert.equal(await matchesPassword(' AB-CD ', 'abcd'), true);
});

test('alias is a pure canonical redirect preserving path/query', async () => {
  const response = await alias.fetch(new Request('https://workbench.ocu.workers.dev/api/v2/events?after=42'));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get('location'), 'https://w.ocu.workers.dev/api/v2/events?after=42');
});

test('edge accepts shared cookie and replaces untrusted proxy headers', async () => {
  const secret = 'test-session-secret'; const token = await newSession(secret);
  let forwarded;
  const env = { WORKBENCH_LOGIN: 'login', WORKBENCH_SESSION_SECRET: secret, WORKBENCH_PROXY_KEY: 'internal',
    WORKBENCH_API: { fetch(request) { forwarded = request; return Response.json({ ok: true }); } } };
  const response = await worker.fetch(new Request('https://w.ocu.workers.dev/api/v2/health', { headers: {
    cookie: `workbench_session=${token}`, authorization: 'bad', 'x-workbench-internal-key': 'bad',
  } }), env);
  assert.equal(response.status, 200);
  assert.equal(forwarded.headers.get('x-workbench-internal-key'), 'internal');
  assert.equal(forwarded.headers.get('cookie'), null); assert.equal(forwarded.headers.get('authorization'), null);
});
