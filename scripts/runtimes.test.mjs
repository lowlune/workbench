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
