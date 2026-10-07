import { decode, fail } from './store.mjs';

export function replayEvents(store, cursor) {
  const latest = store.sequence();
  const oldest = store.db.prepare('SELECT min(seq) AS seq FROM events').get().seq ?? latest + 1;
  if (cursor > latest || cursor < oldest - 1) return { latest, resync: true, events: [] };
  const rows = store.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 501').all(cursor);
  return { latest, resync: rows.length > 500, events: rows.length > 500 ? [] : rows.map(row => ({ ...decode(row.data, {}), seq: row.seq, type: row.type, kind: row.kind || row.type, conversationId: row.conversation_id, runId: row.run_id })) };
}

export function streamEvents(store, req, res, url) {
  let cursor = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw fail('Invalid event cursor.');
  const replay = replayEvents(store, cursor);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const write = text => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength + Buffer.byteLength(text) > 1024 * 1024) { res.destroy(); return; }
    res.write(text);
  };
  const send = event => {
    if (event.seq !== undefined) {
      if (event.seq <= cursor) return;
      cursor = event.seq;
    }
    write(`${event.seq === undefined ? '' : `id: ${event.seq}\n`}data: ${JSON.stringify(event)}\n\n`);
  };
  for (const event of replay.events) send(event);
  // Live-only deltas may have been missed even when the durable cursor is valid.
  // Every connection establishes a fresh snapshot baseline.
  cursor = replay.latest;
  write(`id: ${cursor}\ndata: ${JSON.stringify({ type: 'resync', seq: cursor })}\n\n`);
  store.listeners.add(send);
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 20000);
  const expiry = setTimeout(() => res.end(), 10 * 60 * 1000);
  res.on('close', () => { store.listeners.delete(send); clearInterval(heartbeat); clearTimeout(expiry); });
}
