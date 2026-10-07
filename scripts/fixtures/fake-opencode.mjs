#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const sessions = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  if (url.pathname === '/global/health') return json({ healthy: true });
  if (url.pathname === '/provider') return json({ all: [], connected: [] });
  if (url.pathname === '/session' && req.method === 'POST') { sessions.set('session', null); return json({ id: 'session' }); }
  if (url.pathname === '/session/session/prompt_async') {
    if (process.env.WORKBENCH_PROXY_KEY || process.env.CLOUDFLARE_API_TOKEN) throw Error('env leak');
    try { if (readFileSync(`${process.env.HOME}/.config/secrets/canary`, 'utf8').includes('SECRET')) throw Error('secret leak'); } catch (e) { if (e.message === 'secret leak') throw e; }
    const directory = url.searchParams.get('directory');
    writeFileSync(`${directory}/native-start-${port}`, String(Date.now()));
    sessions.set('session', body.messageID);
    return json({});
  }
  if (url.pathname === '/session/session/message') {
    const id = sessions.get('session');
    return json(id ? [{ info: { id, role: 'user' }, parts: [] }, { info: { id: `reply-${port}`, role: 'assistant', parentID: id, finish: 'stop', time: { completed: Date.now() } }, parts: [{ id: 'text', type: 'text', text: 'done' }] }] : []);
  }
  if (url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
    return;
  }
  if (url.pathname === '/session/status') return json({});
  if (url.pathname === '/permission' || url.pathname === '/question') return json([]);
  return json({});
});
server.listen(port, '127.0.0.1');
