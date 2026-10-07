import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { decode } from './store.mjs';

// Pure response projection. Legacy inline files use a read-only content route.
export function safePart(part, conversationId) {
  if (part.type === 'reasoning') return { id: part.id, type: 'reasoning' };
  if (part.type === 'file') {
    const url = String(part.url || '');
    return { id: part.id, type: 'file', mime: part.mime, filename: part.filename,
      url: url.startsWith('/api/') ? url : url.startsWith('data:image/')
        ? `/api/v2/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(part.id)}` : '' };
  }
  if (part.type === 'tool') {
    const state = part.state || {};
    return { id: part.id, type: 'tool', tool: part.tool, callID: part.callID,
      artifactId: `tool_${part.id}`, state: { status: state.status, title: state.title, time: state.time } };
  }
  return { id: part.id, type: part.type, text: typeof part.text === 'string' ? part.text.slice(0, 120000) : undefined };
}

export function mergeArtifact(previous, state) {
  const result = { ...previous };
  for (const key of ['input', 'output', 'error']) {
    if (!Object.hasOwn(state, key) || state[key] === undefined) continue;
    const value = state[key];
    // Bound values BEFORE encoding so artifacts always remain valid JSON.
    result[key] = typeof value === 'string' ? value.slice(-500000)
      : JSON.stringify(value)?.length > 500000 ? { truncated: true } : value;
  }
  return result;
}

export function createMessageWriter({ store, blobs, modelInfo }) {
  function persistInlineImage(dataUrl, name) {
    if (dataUrl.length > 12 * 1024 * 1024) return '';
    const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return '';
    const [, mime, base64] = match;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return '';
    const hash = createHash('sha256').update(bytes).digest('hex');
    const id = `img_${hash}`;
    if (!store.db.prepare('SELECT id FROM attachments WHERE id=?').get(id)) {
      const ext = mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
      const filename = `${hash}.${ext}`;
      writeFileSync(path.join(blobs, filename), bytes, { mode: 0o600 });
      store.db.prepare('INSERT OR IGNORE INTO attachments VALUES (?,?,?,?,?,?,?)')
        .run(id, String(name || `image.${ext}`).slice(0, 200), mime, bytes.length, hash, filename, Date.now());
    }
    return `/api/v2/attachments/${id}`;
  }

  return function persistMessage(conversationId, commandId, message) {
    const model = modelInfo(`${message.info.providerID}/${message.info.modelID}`, store.conversation(conversationId).engine);
    const info = { role: message.info.role, providerID: message.info.providerID, modelID: message.info.modelID,
      modelName: model?.name || message.info.modelName, contextLimit: model?.contextLimit || message.info.contextLimit,
      tokens: message.info.tokens, cost: message.info.cost };
    const parts = (message.parts || []).map(part => {
      if (part.type === 'file' && String(part.url || '').startsWith('data:')) {
        part = { ...part, url: persistInlineImage(part.url, part.filename) };
      }
      if (part.type === 'tool') {
        const id = `tool_${part.id}`;
        const previous = store.db.prepare('SELECT data FROM artifacts WHERE id=?').get(id);
        const data = JSON.stringify(mergeArtifact(decode(previous?.data, {}), part.state || {}));
        if (data !== '{}' && data !== previous?.data) store.db.prepare('INSERT INTO artifacts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, conversationId, data);
      }
      return safePart(part, conversationId);
    });
    // Do not persist private runner fields (lastText/extra duplicate the content).
    const normalized = { id: message.id, created: message.created, commandId, info, parts };
    // Persist the initial ID once as well: an in-flight page fetch must not
    // erase the empty frame that subsequent live deltas address.
    store.message(conversationId, normalized, commandId);
    store.recordUsage(message.id, conversationId, commandId, info);
  };
}
