import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Store, uid } from '../server/store.mjs';
import { createScheduler } from '../server/scheduler.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync('/tmp/opencode/wb-scheduler-');
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const runs = new Map();
  const started = [];
  const startRun = command => {
    store.status(command.id, 'starting');
    runs.set(command.conversation_id, { command, phase: 'starting', admittedAt: Date.now() });
    started.push(command);
  };
  const scheduler = createScheduler({ store, runs, startRun, maxRuns: () => 3, freeBytes: () => 8 * 1024 ** 3, ...options });
  const chat = (directory = '/home/example') => store.createConversation({ directory });
  const queue = conversation => store.accept(conversation.id, { text: 'task' }, 'p/m', null, uid());
  return { store, runs, started, ...scheduler, chat, queue };
}

for (const directory of ['/home/example', '/control/general', '/tmp/non-git']) test(`concurrent runs share ${directory}, never a conversation`, t => {
  const f = fixture(t);
  const chats = [f.chat(directory), f.chat(directory), f.chat(directory)];
  for (const chat of chats) { f.queue(chat); f.queue(chat); }
  f.tick(); f.tick();
  assert.equal(f.runs.size, 3);
  assert.equal(new Set(f.started.map(command => command.conversation_id)).size, 3);
});

test('50 queued follow-ups cannot starve a later unrelated conversation', t => {
  const f = fixture(t);
  const first = f.chat();
  f.queue(first); f.tick();
  for (let i = 0; i < 50; i++) f.queue(first);
  const second = f.chat(); f.queue(second); f.tick();
  assert.ok(f.runs.has(second.id));
});

test('waiting workers keep capacity; resume cannot oversubscribe resident workers', t => {
  const f = fixture(t, { maxRuns: () => 2 });
  const first = f.chat(); f.queue(first); f.tick();
  const run = f.runs.get(first.id); run.phase = 'waiting_for_user';
  f.store.status(run.command.id, run.phase);
  const second = f.chat(); f.queue(second);
  const third = f.chat(); f.queue(third); f.tick();
  assert.equal(f.runs.size, 2);
  f.store.status(run.command.id, 'running'); f.tick();
  assert.equal(f.runs.size, 2);
});

test('startup memory is reserved within a tick and retried after headroom returns', t => {
  let freeMB = 900;
  const f = fixture(t, { freeBytes: () => freeMB * 1024 ** 2 });
  for (let i = 0; i < 3; i++) f.queue(f.chat());
  f.tick(); assert.equal(f.runs.size, 1); assert.equal(f.metrics.blocked, 'memory');
  freeMB = 4096; f.tick(); assert.equal(f.runs.size, 3);
});

test('scheduler scales to hundreds of queued conversations without over-admitting', t => {
  const f = fixture(t, { maxRuns: () => 8, freeBytes: () => 64 * 1024 ** 3 });
  for (let i = 0; i < 300; i++) f.queue(f.chat(`/home/scale-${i}`));
  let rounds = 0;
  while (f.started.length < 300 && rounds++ < 400) {
    f.tick();
    assert.ok(f.runs.size <= 8, `over-admitted ${f.runs.size}`);
    for (const [id, run] of [...f.runs]) { f.store.status(run.command.id, 'completed'); f.runs.delete(id); }
  }
  assert.equal(f.started.length, 300);
});

test('a queued command with a future retry_at is not admitted until it is due', t => {
  const f = fixture(t);
  const chat = f.chat(); const command = f.queue(chat);
  f.store.db.prepare('UPDATE commands SET retry_at=? WHERE id=?').run(Date.now() + 60000, command.id);
  f.tick(); assert.equal(f.runs.size, 0);
  f.store.db.prepare('UPDATE commands SET retry_at=? WHERE id=?').run(Date.now() - 1000, command.id);
  f.tick(); assert.equal(f.runs.size, 1);
});

test('completion/cancellation frees capacity; failed chat pauses only itself', t => {
  const f = fixture(t, { maxRuns: () => 1 });
  const first = f.chat(); const command = f.queue(first); f.queue(first); f.tick();
  const second = f.chat(); f.queue(second);
  f.store.status(command.id, 'failed', 'crash'); f.runs.delete(first.id); f.tick();
  assert.ok(f.runs.has(second.id)); assert.equal(f.store.conversation(first.id).paused, 1);
});
