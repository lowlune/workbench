import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { PiRuntime, OpenCodeRuntime } from '../server/runtimes.mjs';

function fixture(t) {
  const home = mkdtempSync('/tmp/opencode/wb-engines-'); const dataDir = `${home}/control`;
  const directory = `${dataDir}/general`;
  for (const dir of [directory, `${home}/.config/secrets`, `${home}/.opencode/bin`]) mkdirSync(dir, { recursive: true });
  writeFileSync(`${home}/.config/secrets/canary`, 'SECRET');
  const old = { HOME: process.env.HOME, WORKBENCH_OPENCODE_BIN: process.env.WORKBENCH_OPENCODE_BIN };
  process.env.HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, dataDir, directory };
}

test('real Pi discovery uses sandboxed IPC without provider credentials', { timeout: 30000 }, async t => {
  const f = fixture(t); const runtime = new PiRuntime(f);
  t.after(() => runtime.close());
  const models = await runtime.models();
  assert.ok(Array.isArray(models)); assert.equal(models.length, 0);
});

test('Pi exposes the OpenCode OpenAI OAuth catalog through its Codex adapter', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const authDir = `${f.home}/.local/share/opencode`;
  mkdirSync(authDir, { recursive: true });
  writeFileSync(`${authDir}/auth.json`, JSON.stringify({
    openai: { type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: Date.now() + 86400000, accountId: 'test-account' },
  }), { mode: 0o600 });
  const runtime = new PiRuntime({ ...f, syncSharedOAuthCredential: async () => { throw new Error('Unexpected token refresh in model discovery.'); } });
  t.after(() => runtime.close());
  const models = await runtime.models([
    { id: 'openai/gpt-5.4', provider: 'openai', name: 'GPT-5.4', contextLimit: 1050000, outputLimit: 128000, images: true, reasoning: true },
    { id: 'openai/gpt-5.4-fast', provider: 'openai', name: 'GPT-5.4 Fast', contextLimit: 1050000, outputLimit: 128000, images: true, reasoning: true },
  ]);
  assert.ok(models.some((model) => model.id === 'openai-codex/gpt-5.4'));
  assert.ok(models.some((model) => model.id === 'openai-codex/gpt-5.4-fast'));
});

test('Pi waits for OpenCode to save a refreshed shared OAuth credential', async () => {
  let finishSync;
  let synchronized;
  const replies = [];
  const runtime = new PiRuntime({
    dataDir: '/unused',
    syncSharedOAuthCredential: async value => {
      synchronized = value;
      await new Promise(resolve => { finishSync = resolve; });
    },
  });
  const child = { connected: true, send: value => replies.push(value) };
  const credential = { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: 5678, accountId: 'account' };
  assert.equal(runtime.handleSharedOAuthMessage(child, { type: 'sync-shared-oauth', id: 'sync-1', provider: 'openai', credential }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(synchronized, { provider: 'openai', credential });
  assert.equal(replies.length, 0);
  finishSync();
  await runtime.oauthSyncQueue;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, [{ type: 'sync-shared-oauth-result', id: 'sync-1' }]);
});

test('OpenCode adapter owns separate sandboxed servers for concurrent same-folder runs and reaps them', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const binary = `${f.home}/.opencode/bin/opencode`;
  writeFileSync(binary, readFileSync(new URL('./fixtures/fake-opencode.mjs', import.meta.url)), { mode: 0o700 });
  process.env.WORKBENCH_OPENCODE_BIN = binary;
  const runtime = new OpenCodeRuntime(f); t.after(() => runtime.close());
  const hooks = { binding() {}, nativeMessage() {}, running() {}, message() {}, interaction() {} };
  const run = id => runtime.run({ id, title: id, directory: f.directory, mode: 'build' }, { id, model: 'test/model', input: JSON.stringify({ text: 'task' }) }, [], hooks);
  const pending = Promise.all([run('one'), run('two')]);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(runtime.runs.size, 2);
  const children = [...runtime.runs.values()].map(handle => handle.runtime.child);
  assert.equal(new Set(children.map(child => child.pid)).size, 2);
  await pending;
  assert.equal(runtime.runs.size, 0);
  assert.equal(readdirSync(f.directory).filter(name => name.startsWith('native-start')).length, 2);
  for (const child of children) assert.ok(child.exitCode !== null || child.signalCode);
});

test('OpenCode runtime close resolves within its deadline (no stop hang)', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const binary = `${f.home}/.opencode/bin/opencode`;
  writeFileSync(binary, readFileSync(new URL('./fixtures/fake-opencode.mjs', import.meta.url)), { mode: 0o700 });
  process.env.WORKBENCH_OPENCODE_BIN = binary;
  const runtime = new OpenCodeRuntime(f);
  await runtime.start();
  const started = Date.now();
  await runtime.close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8000, `close() took ${elapsed}ms`);
});

test('a transient OpenCode startup failure does not permanently disable the shared runtime', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const binary = `${f.home}/.opencode/bin/opencode`;
  writeFileSync(binary, '#!/usr/bin/env node\nprocess.exit(3);\n', { mode: 0o700 });
  process.env.WORKBENCH_OPENCODE_BIN = binary;
  const runtime = new OpenCodeRuntime(f); t.after(() => runtime.close());
  await assert.rejects(runtime.start());
  assert.ok(!runtime.closing, 'a startup failure must not set closing');
  writeFileSync(binary, readFileSync(new URL('./fixtures/fake-opencode.mjs', import.meta.url)), { mode: 0o700 });
  await runtime.start();
  assert.ok(runtime.child);
});
