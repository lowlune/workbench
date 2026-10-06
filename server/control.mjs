import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, uid, decode, fail, canonical } from './store.mjs';
import { OpenCodeRuntime, PiRuntime, CAPABILITIES } from './runtimes.mjs';
import { generateTitle } from './titles.mjs';

const execFileAsync = (command, args, options) => new Promise((resolve) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, stdout: stdout || '', stderr: stderr || '' }));
});

/* A run's result should be visible without opening tool outputs. Baseline is
   the pre-run working tree (git stash create), so user edits made before the
   turn are not attributed to the agent. */
async function captureBaseline(directory) {
  const check = await execFileAsync('/usr/bin/git', ['-C', directory, 'rev-parse', '--is-inside-work-tree']);
  if (check.error || check.stdout.trim() !== 'true') return null;
  const stash = await execFileAsync('/usr/bin/git', ['-C', directory, 'stash', 'create']);
  const head = await execFileAsync('/usr/bin/git', ['-C', directory, 'rev-parse', 'HEAD']);
  if (head.error) return null;
  return { tree: (!stash.error && stash.stdout.trim()) || head.stdout.trim(), head: head.stdout.trim(), at: Date.now() };
}

async function summarizeChanges(directory, baseline) {
  if (!baseline) return null;
  const diff = await execFileAsync('/usr/bin/git', ['-C', directory, 'diff', '--numstat', baseline.tree, '--']);
  if (diff.error) return null;
  const files = [];
  for (const line of diff.stdout.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    files.push({ path: match[3], additions: match[1] === '-' ? 0 : Number(match[1]), deletions: match[2] === '-' ? 0 : Number(match[2]) });
  }
  const untracked = await execFileAsync('/usr/bin/git', ['-C', directory, 'ls-files', '--others', '--exclude-standard']);
  if (!untracked.error) {
    for (const relative of untracked.stdout.split('\n').map((value) => value.trim()).filter(Boolean).slice(0, 50)) {
      const full = path.join(directory, relative);
      try {
        const info = statSync(full);
        if (!info.isFile() || info.size > 200000) continue;
        const lines = readFileSync(full, 'utf8').split('\n').length;
        files.push({ path: relative, additions: lines, deletions: 0, untracked: true });
      } catch {}
    }
  }
  if (!files.length) return { files: [], baseline: baseline.tree, head: baseline.head, at: Date.now() };
  return { files, baseline: baseline.tree, head: baseline.head, at: Date.now() };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME || os.homedir();
const DATA = process.env.WORKBENCH_DATA || path.join(ROOT, 'data');
const CONTROL = path.join(DATA, 'control');
const BLOBS = path.join(CONTROL, 'blobs');
const GENERAL = path.join(CONTROL, 'general');
for (const dir of [CONTROL, BLOBS, GENERAL]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const secrets = decode(readFileSync(path.join(HOME, '.config/secrets/workbench-cloudflare-secrets.json'), 'utf8'), {});
const key = process.env.WORKBENCH_PROXY_KEY || secrets.WORKBENCH_PROXY_KEY;
if (!key) throw new Error('WORKBENCH_PROXY_KEY is required.');
const store = new Store(CONTROL);
const oc = new OpenCodeRuntime({ dataDir: CONTROL });
const pi = new PiRuntime({ dataDir: CONTROL });
let legacy;
try {
  legacy = new DatabaseSync(process.env.WORKBENCH_LEGACY_DB || path.join(HOME, '.local/share/opencode/opencode.db'), { readOnly: true });
  legacy.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
} catch {}

const MAX_RUNS = Math.max(1, Math.min(8, Number(process.env.WORKBENCH_MAX_RUNS || 1)));
const MIN_FREE_MB = Math.max(64, Number(process.env.WORKBENCH_MIN_FREE_MB || 256));

let scheduling = false;
let shuttingDown = false;
let catalogRefresh = null;
let lastCatalog = 0;
let catalog = store.getSetting('catalog', []);
let catalogError = null;
const runs = new Map();

/* ---- Providers, connections and catalog ---- */

const PROVIDER_LABELS = {
  'opencode-go': 'OpenCode Go', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google',
  'google-vertex': 'Google Vertex', openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral',
  xai: 'xAI', deepseek: 'DeepSeek', 'github-copilot': 'GitHub Copilot', azure: 'Azure OpenAI',
  cerebras: 'Cerebras', together: 'Together AI', fireworks: 'Fireworks', deepinfra: 'DeepInfra',
};
const providerLabel = (id) => PROVIDER_LABELS[id] || String(id || '').split(/[-_]/).map((word) => word ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
const consoleUrl = (provider) => provider === 'opencode-go' ? 'https://opencode.ai/auth'
  : provider === 'openai' ? 'https://platform.openai.com/usage'
  : provider === 'anthropic' ? 'https://console.anthropic.com/settings/usage' : '';

async function readAuth() {
  return decode(await readFile(path.join(HOME, '.local/share/opencode/auth.json'), 'utf8').catch(() => '{}'), {});
}
async function readPiAuth() {
  return decode(await readFile(path.join(CONTROL, 'pi/auth.json'), 'utf8').catch(() => '{}'), {});
}

function describeOffering(model, engine, auth, piAuth, fetchedAt, stale = false) {
  const entry = auth[model.provider];
  const authKind = engine === 'opencode'
    ? (entry?.type === 'oauth' ? 'subscription' : entry?.type === 'api' ? 'api_key' : 'unknown')
    : (piAuth[model.provider] ? 'api_key' : entry?.type === 'api' ? 'api_key' : 'unknown');
  return {
    ...model,
    engine,
    connectionId: `${engine}:${model.provider}`,
    connectionLabel: providerLabel(model.provider),
    authKind,
    planLabel: engine === 'opencode' && model.provider === 'opencode-go' ? 'Go plan'
      : authKind === 'subscription' ? 'Subscription' : null,
    available: true,
    stale,
    catalogFetchedAt: fetchedAt,
  };
}

async function seedCatalog() {
  if (catalog.length) return;
  const auth = await readAuth();
  const source = decode(await readFile(path.join(HOME, '.cache/opencode/models.json'), 'utf8').catch(() => '{}'), {});
  const seeded = Object.entries(source).filter(([id]) => auth[id]).flatMap(([provider, providerEntry]) => Object.values(providerEntry.models || {}).map((model) => describeOffering({
    id: `${provider}/${model.id}`,
    name: model.name || model.id,
    provider,
    contextLimit: model.limit?.context,
    outputLimit: model.limit?.output,
    images: model.modalities?.input?.includes('image') || false,
    reasoning: !!model.reasoning,
    variants: Object.keys(model.variants || {}),
    cost: model.cost,
  }, 'opencode', auth, {}, Date.now(), true)));
  if (seeded.length) {
    catalog = seeded;
    store.setSetting('catalog', catalog);
  }
}

async function refreshCatalog() {
  if (catalogRefresh) return catalogRefresh;
  catalogRefresh = (async () => {
    const [auth, piAuth] = await Promise.all([readAuth(), readPiAuth()]);
    const results = await Promise.allSettled([oc.models(), pi.models()]);
    const next = [];
    const errors = [];
    results.forEach((result, index) => {
      const engine = index === 0 ? 'opencode' : 'pi';
      if (result.status === 'fulfilled') {
        const list = index === 0 ? result.value : result.value;
        next.push(...list.map((model) => describeOffering(model, engine, auth, piAuth, Date.now())));
      } else {
        errors.push(`${engine === 'opencode' ? 'OpenCode' : 'Pi'}: ${result.reason.message}`);
        next.push(...catalog.filter((model) => model.engine === engine).map((model) => ({ ...model, stale: true })));
      }
    });
    catalogError = errors.join('; ') || null;
    if (next.length) {
      catalog = next;
      store.setSetting('catalog', catalog);
    }
    lastCatalog = Date.now();
    store.event('models.changed', null);
  })().finally(() => { catalogRefresh = null; });
  return catalogRefresh;
}

async function connections() {
  const [auth, piAuth] = await Promise.all([readAuth(), readPiAuth()]);
  const list = [];
  for (const [provider, value] of Object.entries(auth)) {
    const models = catalog.filter((model) => model.engine === 'opencode' && model.provider === provider);
    list.push({
      id: `opencode:${provider}`, engine: 'opencode', provider, label: providerLabel(provider),
      auth: value.type === 'oauth' ? 'OAuth / subscription' : 'API key',
      authKind: value.type === 'oauth' ? 'subscription' : 'api_key',
      health: models.length ? 'ok' : (catalogError ? 'error' : 'unknown'),
      healthMessage: models.length ? null : catalogError,
      modelCount: models.length, consoleUrl: consoleUrl(provider),
      quotaStatus: 'not_available', checkedAt: lastCatalog || null,
    });
  }
  const piProviders = new Set([...Object.keys(piAuth), ...catalog.filter((model) => model.engine === 'pi').map((model) => model.provider)]);
  for (const provider of piProviders) {
    const models = catalog.filter((model) => model.engine === 'pi' && model.provider === provider);
    const shared = auth[provider]?.type === 'api';
    list.push({
      id: `pi:${provider}`, engine: 'pi', provider, label: providerLabel(provider),
      auth: piAuth[provider] ? 'Pi API key' : shared ? 'Shared OpenCode API key' : 'API key',
      authKind: 'api_key',
      health: models.length ? 'ok' : 'unknown',
      healthMessage: null,
      modelCount: models.length, consoleUrl: consoleUrl(provider),
      quotaStatus: 'not_available', checkedAt: lastCatalog || null,
    });
  }
  return list;
}

function modelInfo(id, engine) {
  return catalog.find((model) => model.id === id && model.engine === engine);
}
function validateModel(id, engine) {
  if (typeof id !== 'string' || id.length > 250 || !modelInfo(id, engine)) throw fail('Choose an available model for this engine.', 409);
  return id;
}
function project(id) {
  if (id === null || id === 'general' || !id) return null;
  const item = store.projects().find((candidate) => candidate.id === id);
  if (!item) throw fail('Project not found.', 404);
  return item;
}
function defaultModel(engine, projectId) {
  const p = project(projectId);
  const candidate = p?.defaults?.[engine] || store.getSetting(`default.${engine}`) || null;
  if (candidate && catalog.some((model) => model.id === candidate && model.engine === engine && model.available !== false)) return candidate;
  const preferred = catalog.find((model) => model.engine === engine && model.provider === 'opencode-go' && model.available !== false)
    || catalog.find((model) => model.engine === engine && model.available !== false);
  return preferred?.id || null;
}
const withCapabilities = (session) => ({ ...session, capabilities: CAPABILITIES[session.engine] || {} });

/* ---- Message persistence ---- */

function safePart(part, conversationId) {
  if (part.type === 'reasoning') return { id: part.id, type: 'reasoning' };
  if (part.type === 'file') {
    return {
      id: part.id, type: 'file', mime: part.mime, filename: part.filename,
      url: String(part.url || '').startsWith('data:') ? `/api/v2/conversations/${conversationId}/files/${part.id}`
        : String(part.url || '').startsWith('/api/') ? part.url : '',
    };
  }
  if (part.type === 'tool') {
    const state = part.state || {};
    const artifactId = `tool_${part.id}`;
    const details = JSON.stringify({ input: state.input, output: state.output, error: state.error });
    if (details !== '{}') {
      store.db.prepare('INSERT INTO artifacts(id,conversation_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE length(excluded.data) >= length(artifacts.data) OR length(artifacts.data) < 2').run(artifactId, conversationId, details.slice(0, 2_000_000));
    }
    return { id: part.id, type: 'tool', tool: part.tool, callID: part.callID, artifactId, state: { status: state.status, title: state.title, time: state.time } };
  }
  return { id: part.id, type: part.type, text: typeof part.text === 'string' ? part.text.slice(0, 120000) : undefined };
}

function persistMessage(conversationId, commandId, message) {
  const m = modelInfo(`${message.info.providerID}/${message.info.modelID}`, store.conversation(conversationId).engine);
  const info = {
    role: message.info.role,
    providerID: message.info.providerID,
    modelID: message.info.modelID,
    modelName: m?.name || message.info.modelName,
    contextLimit: m?.contextLimit || message.info.contextLimit,
    tokens: message.info.tokens,
    cost: message.info.cost,
  };
  const normalized = { ...message, info, parts: message.parts.map((part) => safePart(part, conversationId)) };
  store.message(conversationId, normalized, commandId);
  store.recordUsage(message.id, conversationId, commandId, info);
}

/* ---- Title jobs ---- */

async function maybeGenerateTitle(conversationId, force = false) {
  const settingKey = `title.${conversationId}`;
  if (!force && store.getSetting(settingKey)) return;
  store.setSetting(settingKey, 'pending');
  const first = store.db.prepare('SELECT input FROM commands WHERE conversation_id=? ORDER BY created,id LIMIT 1').get(conversationId);
  const text = decode(first?.input, {}).text || '';
  if (!text.trim()) {
    store.setSetting(settingKey, 'fallback');
    return;
  }
  const result = await generateTitle({ conversationId, firstUserText: text });
  if (!result) {
    store.setSetting(settingKey, force ? 'manual' : 'fallback');
    return;
  }
  store.patchConversation(conversationId, { title: result.title });
  const usage = result.usage || {};
  const [, modelId] = result.model.split('/');
  store.recordUsage(`title_${conversationId}_${Date.now()}`, conversationId, null, {
    providerID: 'opencode-go', modelID: modelId,
    tokens: { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0 },
  }, 'title-job');
  store.setSetting(settingKey, 'generated');
}

/* ---- Legacy import (opencode.sqlite) ---- */

function importProjects() {
  try {
    for (const entry of readdirSync(path.join(HOME, 'projects'), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) store.addProject(path.join(HOME, 'projects', entry.name), entry.name);
    }
  } catch {}
}

function importLegacy() {
  if (!legacy) return;
  const archive = path.join(HOME, '.local/share/workbench/legacy-archive');
  const readJson = (file) => {
    for (const candidate of [path.join(DATA, file), path.join(archive, file)]) {
      try { return readFileSync(candidate, 'utf8'); } catch {}
    }
    return '{}';
  };
  const metadata = decode(readJson('session-meta.json'), {});
  const preferences = decode(readJson('session-models.json'), {});
  const rows = legacy.prepare('SELECT id,title,directory,parent_id,time_created,time_updated,model FROM session').all();
  store.transaction(() => {
    for (const row of rows.filter((item) => !item.parent_id && !item.directory.startsWith('/tmp/opencode/workbench-'))) {
      const p = store.projectFor(row.directory);
      const m = decode(row.model);
      store.db.prepare(`INSERT OR IGNORE INTO conversations(id,title,engine,directory,project_id,legacy_id,model,pinned,hidden,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id, metadata.titles?.[row.id] || row.title || 'Imported conversation', 'opencode', row.directory, p?.id || null, row.id,
          preferences.sessions?.[row.id] || (m?.providerID && m?.id ? `${m.providerID}/${m.id}` : null),
          Number(!!metadata.pinned?.[row.id]), Number(!!metadata.hidden?.[row.id]), row.time_created, row.time_updated);
    }
    if (!store.getSetting('legacy-usage-imported')) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const item of legacy.prepare('SELECT id,session_id,data FROM message').all()) {
        const info = decode(item.data, {});
        if (info.role !== 'assistant') continue;
        let root = byId.get(item.session_id);
        const visited = new Set();
        while (root?.parent_id && !visited.has(root.id)) { visited.add(root.id); root = byId.get(root.parent_id); }
        if (root && store.db.prepare('SELECT id FROM conversations WHERE id=?').get(root.id)) {
          store.recordUsage(item.id, root.id, null, info, 'imported-runtime');
          store.db.prepare('UPDATE usage SET created=? WHERE id=?').run(info.time?.created || root.time_created, item.id);
        }
      }
      store.setSetting('legacy-usage-imported', true);
    }
    if (!store.getSetting('legacy-search-imported')) {
      const parents = new Map(rows.map((row) => [row.id, row.parent_id]));
      const roots = new Set(store.db.prepare('SELECT id FROM conversations').all().map((row) => row.id));
      const insert = store.db.prepare('INSERT INTO message_search VALUES (?,?,?)');
      for (const part of legacy.prepare("SELECT p.id,p.session_id,json_extract(p.data,'$.text') AS text FROM part p WHERE json_extract(p.data,'$.type')='text'").iterate()) {
        let root = part.session_id;
        const seen = new Set();
        while (parents.get(root) && !seen.has(root)) { seen.add(root); root = parents.get(root); }
        if (roots.has(root) && part.text) insert.run(`legacy_${part.id}`, root, String(part.text).slice(0, 120000));
      }
      store.setSetting('legacy-search-imported', true);
    }
  });
}

function legacyPage(conversation, before, limit = 30) {
  if (!legacy || !conversation.legacy_id) return { messages: [], hasMoreMessages: false };
  let rows;
  if (before) {
    const cursor = legacy.prepare('SELECT id,time_created FROM message WHERE session_id=? AND id=?').get(conversation.legacy_id, before);
    if (!cursor) return { messages: [], hasMoreMessages: false };
    rows = legacy.prepare('SELECT id,time_created,data FROM message WHERE session_id=? AND (time_created<? OR (time_created=? AND id<?)) ORDER BY time_created DESC,id DESC LIMIT ?').all(conversation.legacy_id, cursor.time_created, cursor.time_created, cursor.id, limit + 1);
  } else {
    rows = legacy.prepare('SELECT id,time_created,data FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT ?').all(conversation.legacy_id, limit + 1);
  }
  const messages = rows.slice(0, limit).reverse().map((row) => {
    const info = decode(row.data, {});
    const m = modelInfo(`${info.providerID}/${info.modelID}`, 'opencode');
    return {
      id: row.id, created: row.time_created,
      info: { role: info.role, providerID: info.providerID, modelID: info.modelID, modelName: m?.name, contextLimit: m?.contextLimit, tokens: info.tokens },
      parts: legacy.prepare('SELECT id,data FROM part WHERE message_id=? ORDER BY time_created,id').all(row.id).map((part) => safePart({ ...decode(part.data, {}), id: part.id }, conversation.legacy_id)),
    };
  });
  return { messages, hasMoreMessages: rows.length > limit };
}

function messagesPage(conversation, before) {
  if (before && !store.db.prepare('SELECT id FROM messages WHERE id=? AND conversation_id=?').get(before, conversation.id)) return legacyPage(conversation, before);
  const own = store.messages(conversation.id, before, 30);
  if (!own.hasMoreMessages && conversation.legacy_id) {
    const old = legacyPage(conversation, null, 30 - own.messages.length || 30);
    return { messages: [...old.messages, ...own.messages], hasMoreMessages: old.hasMoreMessages };
  }
  return own;
}

async function importClips() {
  if (store.getSetting('legacy-clips-imported')) return;
  const archive = path.join(HOME, '.local/share/workbench/legacy-archive');
  const clipsPath = existsSync(path.join(DATA, 'clips.json')) ? path.join(DATA, 'clips.json') : path.join(archive, 'clips.json');
  const clips = decode(await readFile(clipsPath, 'utf8').catch(() => '[]'), []);
  for (const clip of clips) {
    let attachmentId = null;
    if (clip.kind === 'image' && /^[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(clip.filename || '')) {
      const sourceDir = existsSync(path.join(DATA, 'clips')) ? path.join(DATA, 'clips') : path.join(archive, 'clips');
      const bytes = await readFile(path.join(sourceDir, clip.filename)).catch(() => null);
      if (!bytes) continue;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const filename = `${hash}${path.extname(clip.filename)}`;
      attachmentId = `legacy_${clip.id}`;
      await writeFile(path.join(BLOBS, filename), bytes, { mode: 0o600 });
      store.db.prepare('INSERT OR IGNORE INTO attachments VALUES (?,?,?,?,?,?,?)').run(attachmentId, clip.filename, clip.mime, bytes.length, hash, filename, clip.created || Date.now());
    }
    store.db.prepare('INSERT OR IGNORE INTO clips(id,title,text,attachment_id,created) VALUES (?,?,?,?,?)').run(clip.id, (clip.text || 'Screenshot').slice(0, 80), clip.text || '', attachmentId, clip.created || Date.now());
  }
  store.setSetting('legacy-clips-imported', true);
}

function reconcileRecordedRuns() {
  if (!legacy) return;
  for (const command of store.db.prepare("SELECT r.*,c.native_id,c.engine FROM commands r JOIN conversations c ON c.id=r.conversation_id WHERE r.status IN ('interrupted','uncertain') AND c.engine='opencode' AND r.native_message IS NOT NULL").all()) {
    const messages = legacy.prepare("SELECT id,time_created,data FROM message WHERE session_id=? AND json_extract(data,'$.parentID')=? ORDER BY time_created,id").all(command.native_id, command.native_message);
    let complete = false;
    for (const row of messages) {
      const info = decode(row.data, {});
      const parts = legacy.prepare('SELECT id,data FROM message WHERE id=? ORDER BY time_created,id').all(row.id)
        .map((part) => ({ ...decode(part.data, {}), id: part.id }));
      persistMessage(command.conversation_id, command.id, { id: row.id, created: row.time_created, info, parts });
      if (info.time?.completed && info.finish && !['tool-calls', 'unknown'].includes(info.finish) && !info.error) complete = true;
    }
    if (complete) store.status(command.id, 'succeeded');
  }
}

/* ---- Scheduler ---- */

function availableBytes() {
  try {
    return Number(readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0) * 1024;
  } catch {
    return os.freemem();
  }
}
function activeRunCount() {
  let count = 0;
  for (const run of runs.values()) if (!run.waiting) count += 1;
  return count;
}
function workspaceBusy(directory) {
  for (const run of runs.values()) if (run.conversation.directory === directory) return true;
  return false;
}

function startRun(command) {
  const conversation = store.conversation(command.conversation_id);
  const runtime = conversation.engine === 'pi' ? pi : oc;
  const run = { command, conversation, runtime, cancelled: false, waiting: false };
  runs.set(conversation.id, run);
  store.status(command.id, 'starting');
  void (async () => {
    try {
      canonical(conversation.directory);
      validateModel(command.model, conversation.engine);
      const baseline = await captureBaseline(conversation.directory);
      const input = decode(command.input, {});
      const attachments = attachmentsFor((input.attachments || []).map((attachment) => attachment.id));
      if (attachments.some((attachment) => attachment.mime.startsWith('image/')) && !modelInfo(command.model, conversation.engine)?.images) {
        throw fail('Selected model does not accept images. Choose a vision model.');
      }
      const handoff = !conversation.native_id ? store.getSetting(`handoff.${conversation.id}`) : null;
      const runtimeCommand = handoff
        ? { ...command, input: JSON.stringify({ ...input, text: `Previous conversation context (reference only):\n${handoff}\n\nCurrent request:\n${input.text}` }) }
        : command;
      await runtime.run(conversation, runtimeCommand, attachments, {
        binding: (nativeId) => store.db.prepare('UPDATE conversations SET native_id=? WHERE id=?').run(nativeId, conversation.id),
        nativeMessage: (id) => store.db.prepare('UPDATE commands SET native_message=? WHERE id=?').run(id, command.id),
        running: () => {
          if (run.cancelled) throw new Error('Run cancelled before dispatch.');
          store.status(command.id, 'running');
        },
        message: (message) => persistMessage(conversation.id, command.id, message),
        interaction: (id, kind, data) => {
          const previous = store.db.prepare('SELECT status FROM interactions WHERE id=?').get(id);
          if (previous) return;
          store.db.prepare('INSERT INTO interactions(id,conversation_id,kind,data) VALUES (?,?,?,?)').run(id, conversation.id, kind, JSON.stringify(data));
          run.waiting = true;
          store.status(command.id, 'waiting');
          store.event('interaction.created', conversation.id);
          void tick();
        },
        interactionClosed: (id) => {
          store.db.prepare("UPDATE interactions SET status='answered' WHERE id=?").run(id);
          run.waiting = false;
          if (!run.cancelled) store.status(command.id, 'running');
          void tick();
        },
      });
      if (run.cancelled) store.status(command.id, 'cancelled');
      else {
        store.status(command.id, 'succeeded');
        void (async () => {
          try {
            const summary = await summarizeChanges(conversation.directory, baseline);
            if (summary) store.db.prepare('INSERT OR REPLACE INTO artifacts VALUES (?,?,?)').run(`changes_${command.id}`, conversation.id, JSON.stringify(summary));
          } catch {}
          await maybeGenerateTitle(conversation.id).catch(() => {});
        })();
      }
    } catch (error) {
      store.status(
        command.id,
        run.cancelled ? 'cancelled' : error.uncertain ? 'uncertain' : 'failed',
        run.cancelled ? null : error.message,
      );
    } finally {
      runs.delete(conversation.id);
      void tick();
    }
  })();
}

async function tick() {
  if (scheduling || shuttingDown) return;
  scheduling = true;
  try {
    if (availableBytes() < MIN_FREE_MB * 1024 * 1024) return;
    while (activeRunCount() < MAX_RUNS) {
      const candidates = store.db.prepare("SELECT c.* FROM commands c JOIN conversations s ON s.id=c.conversation_id WHERE c.status='queued' AND s.paused=0 ORDER BY c.created,c.id LIMIT 25").all();
      const command = candidates.find((candidate) => !runs.has(candidate.conversation_id) && !workspaceBusy(store.conversation(candidate.conversation_id).directory));
      if (!command) break;
      startRun(command);
    }
  } finally {
    scheduling = false;
  }
}

/* ---- Attachments and clips ---- */

function attachmentsFor(ids) {
  if (!Array.isArray(ids) || ids.length > 4) throw fail('Attach up to four files.');
  return ids.map((id) => {
    const attachment = store.db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
    if (!attachment) throw fail('Attachment not found.', 404);
    return { ...attachment, filePath: path.join(BLOBS, attachment.filename) };
  });
}

/* ---- System telemetry, processes and read-only assistant ---- */

const SYSTEM_SAMPLE_MS = 15000;
const SYSTEM_SAMPLE_LIMIT = 240;
const PROCESS_LIMIT = 25;
const KILL_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT'];
const systemSamples = [];
let lastCpuPercent = 0;
let lastCpuTimes = readCpuTimes();

function readSwap() {
  try {
    const text = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(text.match(/^SwapTotal:\s+(\d+)/m)?.[1] || 0) * 1024;
    const free = Number(text.match(/^SwapFree:\s+(\d+)/m)?.[1] || 0) * 1024;
    return { total, free, used: total - free };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

function readCpuTimes() {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n').find((row) => row.startsWith('cpu '));
    if (!line) return { idle: 0, total: 0 };
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    return { idle: (values[3] || 0) + (values[4] || 0), total: values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) };
  } catch {
    return { idle: 0, total: 0 };
  }
}

/* CPU percent is derived only by the sampler so interleaved requests cannot
   skew the delta; windows shorter than ~1.5s of CPU time keep the last value. */
function cpuPercent() {
  const next = readCpuTimes();
  const idleDelta = next.idle - lastCpuTimes.idle;
  const totalDelta = next.total - lastCpuTimes.total;
  lastCpuTimes = next;
  if (totalDelta <= 150) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

function systemStats() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    load: os.loadavg().map((value) => Number(value.toFixed(2))),
    cpuCount: os.cpus().length,
    memoryTotal: total,
    memoryFree: free,
    memoryUsed: total - free,
    memoryPercent: Math.round(((total - free) / total) * 100),
    swap: readSwap(),
    uptime: os.uptime(),
  };
}

function readDisk() {
  try {
    const stats = statfsSync(HOME);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const used = total - free;
    return { total, free, used, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
  } catch {
    return { total: 0, free: 0, used: 0, percent: 0 };
  }
}

function sampleSystem() {
  const stats = systemStats();
  const cpu = cpuPercent();
  if (cpu !== null) lastCpuPercent = cpu;
  const sample = { t: Date.now(), cpu: lastCpuPercent, memoryPercent: stats.memoryPercent, memoryUsed: stats.memoryUsed };
  systemSamples.push(sample);
  if (systemSamples.length > SYSTEM_SAMPLE_LIMIT) systemSamples.splice(0, systemSamples.length - SYSTEM_SAMPLE_LIMIT);
  return sample;
}

function systemSnapshot() {
  const base = systemStats();
  return { ...base, cpu: { percent: lastCpuPercent, cores: base.cpuCount }, disk: readDisk(), sampledAt: Date.now() };
}

async function listProcesses() {
  const result = await execFileAsync('/usr/bin/ps', ['-eo', 'pid=,pcpu=,pmem=,etimes=,user=,comm=,args=', '--sort=-pcpu', '--no-headers']);
  if (result.error) throw fail('Could not read the process list.', 500);
  const processes = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      cpu: Number(match[2]),
      memory: Number(match[3]),
      etimes: Number(match[4]),
      user: match[5],
      name: match[6],
      args: match[7].slice(0, 160),
    });
    if (processes.length >= PROCESS_LIMIT) break;
  }
  return processes;
}

async function killProcess(req, res, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw fail('Invalid process ID.', 400);
  if (pid === process.pid || pid === process.ppid) throw fail('Refusing to kill the Workbench control plane.', 403);
  const b = await body(req);
  const signal = String(b.signal || 'SIGTERM');
  if (!KILL_SIGNALS.includes(signal)) throw fail('Signal must be SIGTERM, SIGKILL or SIGINT.', 400);
  let status;
  try {
    status = readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    throw fail('Process not found.', 404);
  }
  const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
  if (!Number.isSafeInteger(uid)) throw fail('Process not found.', 404);
  if (uid !== process.getuid()) throw fail('Only processes owned by the Workbench user can be stopped.', 403);
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') throw fail('Process not found.', 404);
    if (error.code === 'EPERM') throw fail('Only processes owned by the Workbench user can be stopped.', 403);
    throw fail('Could not stop the process.', 409);
  }
  return json(res, 200, { killed: true, pid, signal });
}

function transcriptFor(conversationId) {
  const page = messagesPage(store.conversation(conversationId));
  return page.messages
    .map((message) => {
      if (!['user', 'assistant'].includes(message.info?.role)) return null;
      const text = message.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
      return text ? `${message.info.role === 'user' ? 'User' : 'Assistant'}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(-8000);
}

async function assistant(req, res) {
  const b = await body(req);
  const conversationId = typeof b.conversationId === 'string' ? b.conversationId : '';
  if (!conversationId) throw fail('Conversation is required.');
  const auth = await readAuth();
  const apiKey = auth['opencode-go']?.key;
  if (!apiKey) throw fail('No OpenCode Go credentials are available.', 503);
  const transcript = transcriptFor(conversationId);
  const history = (Array.isArray(b.messages) ? b.messages : [])
    .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .slice(-20)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 8000) }));
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const send = (payload) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const upstream = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-opencode-session': conversationId },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        stream: true,
        max_tokens: 1200,
        temperature: 0.3,
        messages: [
          { role: 'system', content: `You are Workbench Assistant, a read-only helper inside a coding console. Answer questions about the conversation below. Be concise. You cannot run commands or change files.\n\nCONVERSATION (oldest first, truncated):\n${transcript}` },
          ...history,
        ],
      }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 500);
      throw new Error(`OpenCode Go request failed (${upstream.status})${detail ? `: ${detail}` : ''}`);
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) send({ delta });
        } catch {}
      }
    }
    send({ done: true });
    res.end();
  } catch (error) {
    send({ error: error.name === 'AbortError' ? 'The assistant request was cancelled.' : error.message || 'The assistant request failed.' });
    res.end();
  }
}

/* ---- HTTP ---- */

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
async function body(req, max = 256000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw fail('Request too large.', 413);
    chunks.push(chunk);
  }
  const result = decode(Buffer.concat(chunks).toString());
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('Invalid JSON.');
  return result;
}
function authenticate(req) {
  const received = Buffer.from(String(req.headers['x-workbench-internal-key'] || ''));
  const expected = Buffer.from(key);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function streamEvents(req, res, url) {
  let cursor = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw fail('Invalid event cursor.');
  const latest = store.sequence();
  const oldest = store.db.prepare('SELECT min(seq) AS seq FROM events').get().seq || 0;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const send = (event) => {
    if (event.seq <= cursor) return;
    cursor = event.seq;
    /* Backpressure must not drop the client: Node buffers the bounded
       replay (<=501 events) and slow clients are expired after 10 minutes. */
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  if (cursor > latest || (cursor > 0 && cursor < oldest - 1)) {
    res.write(`id: ${latest}\ndata: ${JSON.stringify({ type: 'resync', seq: latest })}\n\n`);
    cursor = latest;
  }
  const rows = store.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 501').all(cursor);
  if (rows.length > 500) {
    res.write(`id: ${latest}\ndata: ${JSON.stringify({ type: 'resync', seq: latest })}\n\n`);
    cursor = latest;
  } else {
    for (const row of rows) send({ seq: row.seq, type: row.type, conversationId: row.conversation_id, ...decode(row.data, {}) });
  }
  store.listeners.add(send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  const expiry = setTimeout(() => res.end(), 10 * 60 * 1000);
  res.on('close', () => { store.listeners.delete(send); clearInterval(heartbeat); clearTimeout(expiry); });
}

async function upload(req, res, url) {
  const mime = String(req.headers['content-type'] || '').split(';')[0];
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'text/plain': 'txt', 'text/markdown': 'md', 'application/json': 'json' };
  if (!extensions[mime]) throw fail('Upload PNG, JPEG, WebP, GIF, text, Markdown or JSON.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw fail('Each attachment must be at most 5 MB.', 413);
    chunks.push(chunk);
  }
  if (!size) throw fail('Empty attachment.');
  const bytes = Buffer.concat(chunks);
  const hex = bytes.subarray(0, 12).toString('hex');
  if ((mime === 'image/png' && !hex.startsWith('89504e470d0a1a0a'))
    || (mime === 'image/jpeg' && !hex.startsWith('ffd8ff'))
    || (mime === 'image/gif' && !bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/))
    || (mime === 'image/webp' && !(bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'))) {
    throw fail('File content does not match its image type.', 415);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const id = uid('att_');
  const filename = `${hash}.${extensions[mime]}`;
  await writeFile(path.join(BLOBS, filename), bytes, { mode: 0o600 });
  const name = String(url.searchParams.get('name') || `attachment.${extensions[mime]}`).slice(0, 200);
  store.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?)').run(id, name, mime, size, hash, filename, Date.now());
  json(res, 201, { attachment: { id, name, mime, bytes: size, url: `/api/v2/attachments/${id}` } });
}

async function routes(req, res) {
  if (!authenticate(req)) return json(res, 403, { error: 'Forbidden.' });
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/^\/api\/v2/, '');
  const method = req.method;

  if (route === '/health') return json(res, 200, { ok: true, version: 3, runs: [...runs.values()].map((run) => ({ conversationId: run.conversation.id, commandId: run.command.id, waiting: run.waiting })), maxRuns: MAX_RUNS });
  if (route === '/events' && method === 'GET') return streamEvents(req, res, url);

  if (route === '/bootstrap' && method === 'GET') {
    const list = store.list({ limit: 60 });
    return json(res, 200, {
      ...list,
      sessions: list.sessions.map(withCapabilities),
      projects: store.projects(),
      connections: await connections(),
      seq: store.sequence(),
      defaults: { opencode: defaultModel('opencode'), pi: defaultModel('pi') },
      engines: ['opencode', 'pi'],
      capabilities: CAPABILITIES,
      maxRuns: MAX_RUNS,
    });
  }

  if (route === '/projects' && method === 'POST') {
    const b = await body(req);
    const directory = canonical(String(b.directory || ''));
    const allowed = (process.env.WORKBENCH_PROJECT_ROOTS || path.join(HOME, 'projects')).split(':').map((root) => canonical(root));
    if (!allowed.some((root) => directory === root || directory.startsWith(`${root}${path.sep}`))) throw fail('Choose a folder under an allowed project root.');
    return json(res, 201, { project: store.addProject(directory, b.name) });
  }
  const projectMatch = /^\/projects\/([^/]+)$/.exec(route);
  if (projectMatch && method === 'DELETE') {
    const p = project(projectMatch[1]);
    store.transaction(() => {
      store.db.prepare('UPDATE conversations SET project_id=NULL WHERE project_id=?').run(p.id);
      store.db.prepare('UPDATE clips SET project_id=NULL WHERE project_id=?').run(p.id);
      store.db.prepare('DELETE FROM workspaces WHERE project_id=?').run(p.id);
      store.db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
      store.db.prepare("DELETE FROM settings WHERE key LIKE ?").run(`project.${p.id}.%`);
      store.event('projects.changed', null);
    });
    return json(res, 200, { deleted: true });
  }
  if (projectMatch && method === 'PATCH') {
    const p = project(projectMatch[1]);
    const b = await body(req);
    const engine = b.engine === 'pi' ? 'pi' : 'opencode';
    if (b.model) validateModel(b.model, engine);
    store.setSetting(`project.${p.id}.${engine}`, b.model || null);
    store.event('projects.changed', null);
    return json(res, 200, { ok: true });
  }

  if (route === '/models' && method === 'GET') {
    if (!lastCatalog || Date.now() - lastCatalog > 600000) void refreshCatalog().catch(() => {});
    return json(res, 200, {
      models: catalog,
      refreshing: !!catalogRefresh,
      error: catalogError,
      fetchedAt: lastCatalog || null,
      defaults: { opencode: defaultModel('opencode'), pi: defaultModel('pi') },
      favorites: store.getSetting('favorites', []),
      connections: await connections(),
    });
  }
  if (route === '/models/refresh' && method === 'POST') {
    void refreshCatalog().catch(() => {});
    return json(res, 202, { refreshing: true });
  }
  if (route === '/settings' && method === 'POST') {
    const b = await body(req);
    if (b.defaultModel) {
      const engine = b.engine === 'pi' ? 'pi' : 'opencode';
      validateModel(b.defaultModel, engine);
      store.setSetting(`default.${engine}`, b.defaultModel);
    }
    if (Array.isArray(b.favorites)) store.setSetting('favorites', b.favorites.filter((value) => typeof value === 'string').slice(0, 100));
    store.event('models.changed', null);
    return json(res, 200, { ok: true });
  }

  if (route === '/connections' && method === 'GET') return json(res, 200, { connections: await connections() });
  if (route === '/connections' && method === 'POST') {
    const b = await body(req);
    if (!/^[a-z0-9._-]{1,80}$/.test(b.provider || '') || typeof b.apiKey !== 'string' || !b.apiKey || b.apiKey.length > 8192) throw fail('Provider and API key are required.');
    if (b.engine === 'pi') {
      const file = path.join(CONTROL, 'pi/auth.json');
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const data = decode(await readFile(file, 'utf8').catch(() => '{}'), {});
      data[b.provider] = { type: 'api_key', key: b.apiKey };
      const temp = `${file}.${uid()}.tmp`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, file);
    } else {
      await oc.request(`/auth/${encodeURIComponent(b.provider)}`, { type: 'api', key: b.apiKey }, undefined, 30000, 'PUT');
    }
    void refreshCatalog();
    return json(res, 200, { connected: true });
  }
  if (route === '/connections/oauth/start' && method === 'POST') {
    const b = await body(req);
    if (!/^[a-z0-9._-]{1,80}$/.test(b.provider || '')) throw fail('Invalid provider.');
    const methods = await oc.request('/provider/auth');
    const index = (methods[b.provider] || []).findIndex((method) => method.type === 'oauth');
    if (index < 0) throw fail('This provider does not offer OAuth through OpenCode. Use an API key.');
    const authorization = await oc.request(`/provider/${b.provider}/oauth/authorize`, { method: index });
    return json(res, 200, { ...authorization, provider: b.provider, authMethod: index });
  }
  if (route === '/connections/oauth/complete' && method === 'POST') {
    const b = await body(req);
    if (!/^[a-z0-9._-]{1,80}$/.test(b.provider || '') || !Number.isSafeInteger(b.authMethod)) throw fail('Invalid authorization.');
    await oc.request(`/provider/${b.provider}/oauth/callback`, { method: b.authMethod, ...(b.code ? { code: String(b.code).slice(0, 8192) } : {}) }, undefined, 120000);
    void refreshCatalog();
    return json(res, 200, { connected: true });
  }

  if (route === '/conversations' && method === 'GET') {
    const result = store.list({ projectId: url.searchParams.get('projectId') ?? undefined, q: (url.searchParams.get('q') || '').slice(0, 200), before: url.searchParams.get('cursor') || undefined, hidden: url.searchParams.get('hidden') === 'true' });
    return json(res, 200, { ...result, sessions: result.sessions.map(withCapabilities) });
  }
  if (route === '/conversations' && method === 'POST') {
    const b = await body(req);
    if (!['opencode', 'pi'].includes(b.engine)) throw fail('Choose OpenCode or Pi.');
    const p = project(b.projectId);
    if (b.workspace && (!p || ![p.directory, ...(p.workspaces || [])].includes(b.workspace))) throw fail('Choose a workspace belonging to this project.');
    const directory = p ? canonical(b.workspace || p.directory) : GENERAL;
    const id = b.id || uid('chat_');
    if (!/^[\w-]{8,100}$/.test(id)) throw fail('Invalid conversation ID.');
    const existing = store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if (existing) {
      if (existing.engine !== b.engine || existing.project_id !== (p?.id || null)) throw fail('Conversation ID conflict.', 409);
      return json(res, 200, { session: withCapabilities(store.view(existing)) });
    }
    const model = validateModel(b.model || defaultModel(b.engine, p?.id), b.engine);
    const session = store.createConversation({ id, title: String(b.title || 'New conversation'), engine: b.engine, directory, projectId: p?.id || null, model, mode: b.mode === 'plan' ? 'plan' : 'build' });
    return json(res, 201, { session: withCapabilities(store.view(session)) });
  }

  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(route);
  if (conversationMatch) {
    const c = store.conversation(conversationMatch[1]);
    if (method === 'GET') return json(res, 200, { session: withCapabilities(store.view(c, messagesPage(c, url.searchParams.get('before')))) });
    if (method === 'PATCH') {
      const b = await body(req);
      if (b.model) validateModel(b.model, c.engine);
      if ('projectId' in b) project(b.projectId);
      if ('title' in b) {
        if (typeof b.title !== 'string' || !b.title.trim()) throw fail('Title is required.');
        b.title = b.title.trim().slice(0, 120);
        store.setSetting(`title.${c.id}`, 'manual');
      }
      return json(res, 200, { session: withCapabilities(store.patchConversation(c.id, b, b.revision)) });
    }
  }

  const promptMatch = /^\/conversations\/([^/]+)\/commands$/.exec(route);
  if (promptMatch && method === 'POST') {
    const c = store.conversation(promptMatch[1]);
    const b = await body(req);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    const attachments = attachmentsFor(b.attachmentIds || []);
    if (text.length > 60000 || (!text && !attachments.length)) throw fail('Write a message or attach a file (maximum 60,000 characters).');
    const model = validateModel(b.model || c.model || defaultModel(c.engine, c.project_id), c.engine);
    if (attachments.some((attachment) => attachment.mime.startsWith('image/')) && !modelInfo(model, c.engine)?.images) throw fail('Select a model that supports images.', 409);
    const command = store.accept(c.id, { text, attachments: attachments.map(({ id, name, mime }) => ({ id, name, mime })) }, model, b.reasoning || c.reasoning, b.clientCommandId);
    json(res, 202, { commandId: command.id, status: command.status });
    void tick();
    return;
  }

  const actionMatch = /^\/conversations\/([^/]+)\/(stop|resume|fork|title)$/.exec(route);
  if (actionMatch && method === 'POST') {
    const c = store.conversation(actionMatch[1]);
    const action = actionMatch[2];
    if (action === 'stop') {
      store.patchConversation(c.id, { paused: true });
      const run = runs.get(c.id);
      if (run) {
        run.cancelled = true;
        store.status(run.command.id, 'stopping');
        await run.runtime.stop(c.id);
      }
      void tick();
      return json(res, 200, { stopped: true });
    }
    if (action === 'resume') {
      if (c.paused) store.patchConversation(c.id, { paused: false });
      void tick();
      return json(res, 200, { resumed: true });
    }
    if (action === 'title') {
      await maybeGenerateTitle(c.id, true);
      return json(res, 200, { session: withCapabilities(store.view(store.conversation(c.id))) });
    }
    const b = await body(req);
    const engine = ['opencode', 'pi'].includes(b.engine) ? b.engine : c.engine;
    const p = project(b.projectId ?? c.project_id);
    const model = validateModel(b.model || defaultModel(engine, p?.id), engine);
    const next = store.createConversation({ title: `${c.title} \u00b7 fork`, engine, directory: p?.directory || GENERAL, projectId: p?.id || null, model, mode: c.mode });
    if (engine === 'opencode' && c.engine === 'opencode' && next.directory === c.directory) {
      store.db.prepare('UPDATE conversations SET legacy_id=? WHERE id=?').run(c.native_id || c.legacy_id, next.id);
    } else {
      const text = messagesPage(c).messages.filter((message) => message.parts.some((part) => part.type === 'text'))
        .map((message) => `${message.info.role}: ${message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')}`)
        .join('\n\n').slice(-40000);
      store.message(next.id, { id: uid('handoff_'), created: Date.now(), info: { role: 'assistant' }, parts: [{ id: uid(), type: 'text', text: `Context handoff from \u201c${c.title}\u201d. This is a new ${engine} session.\n\n${text}` }] });
      store.setSetting(`handoff.${next.id}`, text);
    }
    return json(res, 201, { session: withCapabilities(store.view(store.conversation(next.id))) });
  }

  const commandMatch = /^\/commands\/([^/]+)$/.exec(route);
  if (commandMatch) {
    const command = store.db.prepare('SELECT * FROM commands WHERE id=?').get(commandMatch[1]);
    if (!command) throw fail('Command not found.', 404);
    if (method === 'GET') return json(res, 200, { id: command.id, status: command.status, conversationId: command.conversation_id, error: command.error || null });
    if (method === 'DELETE') {
      if (command.status !== 'queued') throw fail('Only queued messages can be removed.', 409);
      store.status(command.id, 'cancelled');
      return json(res, 200, { deleted: true });
    }
  }

  const retryMatch = /^\/commands\/([^/]+)\/retry$/.exec(route);
  if (retryMatch && method === 'POST') {
    const command = store.db.prepare('SELECT * FROM commands WHERE id=?').get(retryMatch[1]);
    if (!command) throw fail('Command not found.', 404);
    if (!['failed', 'interrupted', 'uncertain', 'cancelled'].includes(command.status)) throw fail('Only a finished command can be retried.', 409);
    const conversation = store.conversation(command.conversation_id);
    const input = decode(command.input, {});
    const newId = uid();
    const next = store.accept(conversation.id, input, command.model, command.reasoning, newId);
    json(res, 202, { commandId: next.id, status: next.status });
    void tick();
    return;
  }

  const interactionMatch = /^\/interactions\/([^/]+)$/.exec(route);
  if (interactionMatch && method === 'POST') {
    const interaction = store.db.prepare('SELECT * FROM interactions WHERE id=?').get(interactionMatch[1]);
    if (!interaction) throw fail('Interaction not found.', 404);
    if (interaction.status === 'answered') return json(res, 200, { answered: true });
    if (interaction.status !== 'pending') throw fail('This interaction is no longer pending.', 409);
    const b = await body(req);
    if (interaction.kind === 'permission' && !['once', 'always', 'reject'].includes(b.reply)) throw fail('Invalid permission response.');
    if (interaction.kind === 'question' && !b.reject && (!Array.isArray(b.answers) || !b.answers.every((answer) => Array.isArray(answer) && answer.every((value) => typeof value === 'string')))) throw fail('Choose an answer.');
    store.db.prepare("UPDATE interactions SET status='responding' WHERE id=? AND status='pending'").run(interaction.id);
    try {
      await oc.respond(store.conversation(interaction.conversation_id), interaction, b);
      store.db.prepare("UPDATE interactions SET status='answered' WHERE id=?").run(interaction.id);
      store.event('interaction.answered', interaction.conversation_id);
      const run = runs.get(interaction.conversation_id);
      if (run) {
        run.waiting = false;
        if (!run.cancelled) store.status(run.command.id, 'running');
      }
      return json(res, 200, { answered: true });
    } catch (error) {
      store.db.prepare("UPDATE interactions SET status='pending' WHERE id=?").run(interaction.id);
      throw error;
    }
  }

  if (route === '/attachments' && method === 'POST') return upload(req, res, url);
  const attachmentMatch = /^\/attachments\/([^/]+)$/.exec(route);
  if (attachmentMatch && method === 'GET') {
    const attachment = store.db.prepare('SELECT * FROM attachments WHERE id=?').get(attachmentMatch[1]);
    if (!attachment) throw fail('Attachment not found.', 404);
    res.writeHead(200, { 'content-type': attachment.mime, 'content-length': attachment.bytes, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    return createReadStream(path.join(BLOBS, attachment.filename)).pipe(res);
  }
  const artifactMatch = /^\/artifacts\/([^/]+)$/.exec(route);
  if (artifactMatch && method === 'GET') {
    const artifact = store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactMatch[1]);
    if (!artifact) throw fail('Artifact not found.', 404);
    return json(res, 200, { artifact: decode(artifact.data, { output: artifact.data }) });
  }
  const fileMatch = /^\/conversations\/([^/]+)\/files\/([^/]+)$/.exec(route);
  if (fileMatch && method === 'GET') {
    if (!legacy) throw fail('File not found.', 404);
    const row = legacy.prepare('SELECT data FROM part WHERE id=?').get(fileMatch[2]);
    const part = row ? decode(row.data, {}) : null;
    const inline = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(part?.url || ''));
    if (!part || part.type !== 'file' || !inline) throw fail('File not found.', 404);
    const bytes = Buffer.from(inline[2], 'base64');
    res.writeHead(200, { 'content-type': inline[1], 'content-length': bytes.length, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff' });
    return res.end(bytes);
  }

  const filesMatch = /^\/projects\/([^/]+)\/files$/.exec(route);
  if (filesMatch && method === 'GET') {
    const p = project(filesMatch[1]);
    const root = canonical(p.directory);
    const requested = String(url.searchParams.get('path') || '');
    const target = canonical(requested ? path.resolve(root, requested) : root);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw fail('That file is outside the project.', 400);
    if (!statSync(target).isDirectory()) throw fail('Not a folder.', 400);
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .slice(0, 300)
      .map((entry) => {
        const full = path.join(target, entry.name);
        let size = 0;
        let modified = 0;
        try { const info = statSync(full); size = info.size; modified = info.mtimeMs; } catch {}
        return { path: path.relative(root, full), name: entry.name, directory: entry.isDirectory(), size, modified };
      })
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return json(res, 200, { path: path.relative(root, target), entries });
  }
  const fileContentMatch = /^\/projects\/([^/]+)\/file$/.exec(route);
  if (fileContentMatch && method === 'GET') {
    const p = project(fileContentMatch[1]);
    const root = canonical(p.directory);
    const target = canonical(path.resolve(root, String(url.searchParams.get('path') || '')));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw fail('That file is outside the project.', 400);
    const info = statSync(target);
    if (!info.isFile() || info.size > 1024 * 1024) throw fail('Choose a file smaller than 1 MB.', 413);
    const extension = path.extname(target).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/markdown', '.json': 'application/json' }[extension] || 'text/plain';
    res.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' });
    return createReadStream(target).pipe(res);
  }

  if (route === '/clips' && method === 'GET') {
    const p = url.searchParams.get('projectId');
    const rows = p === 'all' ? store.db.prepare('SELECT * FROM clips ORDER BY pinned DESC,created DESC LIMIT 300').all()
      : p && p !== 'general' ? store.db.prepare('SELECT * FROM clips WHERE project_id=? OR project_id IS NULL ORDER BY pinned DESC,created DESC LIMIT 300').all(p)
        : store.db.prepare('SELECT * FROM clips WHERE project_id IS NULL ORDER BY pinned DESC,created DESC LIMIT 300').all();
    return json(res, 200, { clips: rows.map((clip) => ({ ...clip, projectId: clip.project_id, attachment: clip.attachment_id ? store.db.prepare('SELECT id,name,mime FROM attachments WHERE id=?').get(clip.attachment_id) : null })) });
  }
  if (route === '/clips' && method === 'POST') {
    const b = await body(req);
    const p = project(b.projectId);
    const text = String(b.text || '').trim();
    if (text.length > 50000) throw fail('Clip is too large.');
    if (!text && !b.attachmentId) throw fail('Add text or a file.');
    if (b.attachmentId) attachmentsFor([b.attachmentId]);
    const id = uid('clip_');
    store.db.prepare('INSERT INTO clips(id,project_id,title,text,attachment_id,created) VALUES (?,?,?,?,?,?)').run(id, p?.id || null, String(b.title || text.slice(0, 60) || 'Attachment').slice(0, 120), text, b.attachmentId || null, Date.now());
    store.event('clips.changed', null);
    return json(res, 201, { id });
  }
  const clipMatch = /^\/clips\/([^/]+)$/.exec(route);
  if (clipMatch) {
    if (method === 'DELETE') store.db.prepare('DELETE FROM clips WHERE id=?').run(clipMatch[1]);
    else if (method === 'PATCH') {
      const b = await body(req);
      if ('projectId' in b) store.db.prepare('UPDATE clips SET project_id=? WHERE id=?').run(project(b.projectId)?.id || null, clipMatch[1]);
      if ('pinned' in b) store.db.prepare('UPDATE clips SET pinned=? WHERE id=?').run(Number(!!b.pinned), clipMatch[1]);
      if ('title' in b) store.db.prepare('UPDATE clips SET title=? WHERE id=?').run(String(b.title || '').slice(0, 120), clipMatch[1]);
    } else throw fail('Method not allowed.', 405);
    store.event('clips.changed', null);
    return json(res, 200, { ok: true });
  }

  if (route === '/usage' && method === 'GET') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
    const since = Date.now() - days * 86400000;
    const projectId = url.searchParams.get('projectId');
    const filter = projectId ? (projectId === 'general' ? ' AND c.project_id IS NULL' : ' AND c.project_id=?') : '';
    const args = projectId && projectId !== 'general' ? [since, projectId] : [since];
    const sums = 'count(*) AS requests,sum(u.input) AS input,sum(u.output) AS output,sum(u.cache_read) AS cacheRead,sum(u.cache_write) AS cacheWrite,sum(u.cost) AS cost,sum(u.cost IS NULL) AS unknownCost';
    const totals = store.db.prepare(`SELECT ${sums} FROM usage u JOIN conversations c ON c.id=u.conversation_id WHERE u.created>=?${filter}`).get(...args);
    const daily = store.db.prepare(`SELECT date(u.created/1000,'unixepoch') AS day,${sums} FROM usage u JOIN conversations c ON c.id=u.conversation_id WHERE u.created>=?${filter} GROUP BY day ORDER BY day`).all(...args);
    const byModel = store.db.prepare(`SELECT u.provider,u.model,c.engine AS engine,${sums} FROM usage u JOIN conversations c ON c.id=u.conversation_id WHERE u.created>=?${filter} GROUP BY u.provider,u.model ORDER BY requests DESC`).all(...args);
    const byProject = store.db.prepare(`SELECT coalesce(p.name,'General') AS label,coalesce(c.project_id,'general') AS projectId,${sums} FROM usage u JOIN conversations c ON c.id=u.conversation_id LEFT JOIN projects p ON p.id=c.project_id WHERE u.created>=?${filter} GROUP BY c.project_id ORDER BY requests DESC`).all(...args);
    const byEngine = store.db.prepare(`SELECT c.engine AS engine,${sums} FROM usage u JOIN conversations c ON c.id=u.conversation_id WHERE u.created>=?${filter} GROUP BY c.engine ORDER BY requests DESC`).all(...args);
    return json(res, 200, {
      days, from: since,
      coverage: 'Workbench and imported OpenCode request usage. Subscription usage value is not an invoice; provider quota is separate.',
      totals, daily, byModel, byProject, byEngine,
    });
  }

  if (route === '/system' && method === 'GET') return json(res, 200, systemSnapshot());
  if (route === '/system/history' && method === 'GET') return json(res, 200, { samples: systemSamples, intervalMs: SYSTEM_SAMPLE_MS });
  if (route === '/processes' && method === 'GET') return json(res, 200, { processes: await listProcesses() });
  const killMatch = /^\/processes\/([^/]+)\/kill$/.exec(route);
  if (killMatch && method === 'POST') return killProcess(req, res, Number(killMatch[1]));
  if (route === '/assistant' && method === 'POST') return assistant(req, res);

  throw fail('Not found.', 404);
}

importProjects();
importLegacy();
store.recover();
await seedCatalog();
await importClips();
reconcileRecordedRuns();

const server = createServer((req, res) => {
  routes(req, res).catch((error) => {
    console.error(JSON.stringify({ event: 'request_error', path: req.url?.split('?')[0], message: error.message }));
    if (!res.headersSent) json(res, error.status || 500, { error: error.message });
    else res.destroy();
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.WORKBENCH_CONTROL_PORT || 8788), '127.0.0.1', () => console.log(JSON.stringify({ event: 'control_ready', port: Number(process.env.WORKBENCH_CONTROL_PORT || 8788), maxRuns: MAX_RUNS })));

const scheduler = setInterval(() => void tick(), 2000);
scheduler.unref();
sampleSystem();
const systemSampler = setInterval(sampleSystem, SYSTEM_SAMPLE_MS);
systemSampler.unref();
const prune = setInterval(() => {
  store.db.prepare('DELETE FROM events WHERE created<? AND seq<(SELECT max(seq)-1000 FROM events)').run(Date.now() - 7 * 86400000);
  store.db.prepare('DELETE FROM artifacts WHERE length(data)<2 OR conversation_id NOT IN (SELECT id FROM conversations)').run();
}, 3600000);
prune.unref();
void refreshCatalog().catch((error) => console.warn(error.message));

async function shutdown() {
  shuttingDown = true;
  clearInterval(scheduler);
  clearInterval(systemSampler);
  for (const run of runs.values()) {
    run.cancelled = true;
    store.status(run.command.id, 'interrupted', 'Runner service stopped.');
  }
  oc.close();
  pi.close();
  server.close();
  for (const listener of store.listeners) store.listeners.delete(listener);
  setTimeout(() => { store.close(); legacy?.close(); process.exit(0); }, 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
