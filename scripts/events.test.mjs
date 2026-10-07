import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Store } from '../server/store.mjs';
import { replayEvents, streamEvents } from '../server/event-stream.mjs';
import { createMessageWriter, safePart, mergeArtifact } from '../server/messages.mjs';

function fixture(t) {
  const directory = mkdtempSync('/tmp/opencode/wb-events-');
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('10,000 deltas are live only; final text durable with compact replay', async t => {
  const { store } = fixture(t);
  const c = store.createConversation({ directory: '/tmp' });
  const seq = store.sequence(); const received = [];
  store.listeners.add(event => received.push(event));
  for (let i = 0; i < 10000; i++) store.event('text.delta', c.id, { messageId: 'm', delta: 'x' });
  assert.equal(store.sequence(), seq);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.filter(event => event.type === 'text.delta').length, 10000);
  assert.equal(received.at(-1).seq, undefined);
  store.message(c.id, { id: 'm', info: { role: 'assistant' }, parts: [{ id: 'text', type: 'text', text: 'x'.repeat(10000) }] });
  assert.equal(store.messages(c.id).messages[0].parts[0].text.length, 10000);
  assert.ok(store.db.prepare('SELECT data FROM events ORDER BY seq DESC LIMIT 1').get().data.length < 100);
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 1);
});

test('count/age retention preserves monotonic IDs and resyncs stale/future cursors', t => {
  const { store } = fixture(t);
  for (let i = 0; i < 40; i++) store.event('change', null);
  store.pruneEvents({ maxCount: 10 });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM events').get().n, 10);
  assert.equal(replayEvents(store, 1).resync, true);
  assert.equal(replayEvents(store, 100).resync, true);
  assert.equal(replayEvents(store, 35).events.length, 5);
  const last = store.sequence(); store.pruneEvents({ now: Date.now() + 2 * 86400000 });
  assert.equal(store.sequence(), last);
  assert.equal(store.event('next', null).seq, last + 1);
});

test('SSE reconnect resyncs, transient frames have no ID, slow clients disconnect', async t => {
  const { store } = fixture(t);
  class Response extends EventEmitter {
    writableLength = 0; chunks = []; destroyed = false;
    writeHead() {} flushHeaders() {}
    write(value) { this.chunks.push(value); return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
    end() { this.emit('close'); }
  }
  const res = new Response();
  streamEvents(store, { headers: {} }, res, new URL('http://localhost/events'));
  assert.match(res.chunks[0], /resync/);
  store.event('text.delta', 'c', { delta: 'hello' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(res.chunks.at(-1).startsWith('data: '));
  res.writableLength = 1024 * 1024;
  store.event('text.delta', 'c', { delta: 'overflow' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(res.destroyed, true); assert.equal(store.listeners.size, 0);
});

test('image ingestion writes once, projection is pure, shorter final artifacts replace output', t => {
  const { directory, store } = fixture(t); const blobs = `${directory}/blobs`; mkdirSync(blobs);
  const c = store.createConversation({ directory: '/tmp' });
  const write = createMessageWriter({ store, blobs, modelInfo: () => null });
  const file = { id: 'image', type: 'file', mime: 'image/png', url: 'data:image/png;base64,aGVsbG8=' };
  const message = { id: 'm', info: { role: 'assistant' }, parts: [file, { id: 't', type: 'tool', state: { input: { command: 'test' }, output: 'long initial output' } }] };
  write(c.id, null, message); const seq = store.sequence();
  for (let i = 0; i < 10; i++) safePart(file, c.id);
  assert.equal(store.sequence(), seq); assert.equal(readdirSync(blobs).length, 1);
  message.parts[1].state = { output: 'ok', error: null }; write(c.id, null, message);
  const artifact = JSON.parse(store.db.prepare("SELECT data FROM artifacts WHERE id='tool_t'").get().data);
  assert.equal(artifact.output, 'ok'); assert.equal(artifact.input.command, 'test');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(mergeArtifact({}, { output: '"'.repeat(1000000) }))));
});
