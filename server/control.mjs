import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, uid, decode, fail, canonical, normalizeStatus, RUN_LIVE, RUN_TERMINAL } from './store.mjs';
import { OpenCodeRuntime, PiRuntime, CAPABILITIES } from './runtimes.mjs';
import { generateTitle } from './titles.mjs';
import { createWorktree, worktreeChanges, applyWorktree, discardWorktree, isGitRepo, worktreeRoot, git } from './workspaces.mjs';
import { pacing, listLimits, upsertLimit, removeLimit } from './usage-limits.mjs';
import { createNotification, listNotifications, markNotificationRead, markAllNotificationsRead } from './notifications.mjs';
import { createSmtpMailer, publicSmtpConfig, saveSmtpConfig } from './smtp.mjs';
import { createScheduler } from './scheduler.mjs';
import { streamEvents } from './event-stream.mjs';
import { safePart, createMessageWriter } from './messages.mjs';
import { openLegacy, maintenance } from './legacy.mjs';
import { describeFailure, RETRYABLE_CODES, retryDelay } from './failures.mjs';
import { matchesSecret } from '../shared/auth.mjs';
import { insideDir, resolvedPath } from './security.mjs';

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
let secrets = {};
try { secrets = decode(readFileSync(path.join(HOME, '.config/secrets/workbench-cloudflare-secrets.json'), 'utf8'), {}); } catch {}
const key = process.env.WORKBENCH_PROXY_KEY || secrets.WORKBENCH_PROXY_KEY;
if (!key) throw new Error('WORKBENCH_PROXY_KEY is required.');
const store = new Store(CONTROL);
const oc = new OpenCodeRuntime({ dataDir: CONTROL });
let sharedOAuthSyncQueue = Promise.resolve();
const pi = new PiRuntime({
  dataDir: CONTROL,
  syncSharedOAuthCredential: async ({ provider, credential }) => {
    if (provider !== 'openai' || credential?.type !== 'oauth'
      || typeof credential.access !== 'string' || typeof credential.refresh !== 'string'
      || !Number.isFinite(credential.expires)) throw new Error('Unsupported shared OAuth credential.');
    const update = async () => {
      const auth = await readAuth();
      const current = auth.openai;
      if (current?.type !== 'oauth') throw new Error('The OpenAI OAuth connection is no longer available in OpenCode.');
      /* Both engines may notice an expiring token at the same time. Keep the
         credential with the later expiry rather than rolling OpenCode back. */
      if (Number(current.expires) >= Number(credential.expires)) return;
      await oc.request('/auth/openai', credential, undefined, 30000, 'PUT');
    };
    const task = sharedOAuthSyncQueue.then(update, update);
    sharedOAuthSyncQueue = task.catch(() => {});
    return task;
  },
});
const legacy = openLegacy(process.env.WORKBENCH_LEGACY_DB || path.join(HOME, '.local/share/opencode/opencode.db'));

const MIN_RUNS = 1;
const MAX_RUNS_LIMIT = 8;
const DEFAULT_MAX_RUNS = Math.max(MIN_RUNS, Math.min(MAX_RUNS_LIMIT, Math.floor(Number(process.env.WORKBENCH_MAX_RUNS || 2)) || 2));
const MIN_FREE_MB = Math.max(64, Number(process.env.WORKBENCH_MIN_FREE_MB) || 256);
/* Rough memory a run needs. The scheduler only starts a run when there is
   MIN_FREE_MB + MEM_PER_RUN_MB available, which keeps effective concurrency
   bounded by RAM rather than only by the maxRuns setting. */
const MEM_PER_RUN_MB = Math.max(128, Number(process.env.WORKBENCH_MB_PER_RUN) || 512);

/* Concurrency limit is resolved at scheduling time (§11): a persisted
   `settings.maxRuns` wins, the environment variable provides the process
   default (2, not 1), and the result is always clamped to 1..8. Reading it per
   tick lets a settings change take effect without a restart. */
function maxRuns() {
  const stored = Number(store.getSetting('maxRuns'));
  if (Number.isInteger(stored) && stored >= MIN_RUNS && stored <= MAX_RUNS_LIMIT) return stored;
  return DEFAULT_MAX_RUNS;
}

let shuttingDown = false;
let catalogRefresh = null;
let lastCatalog = 0;
let catalog = store.getSetting('catalog', []);
let catalogError = null;
const runs = new Map();

/* SMTP delivery (§33) is best-effort and completely off the run path. The
   mailer observes `notification.created` events and silently no-ops unless an
   `smtp.host` is configured. Errors only downgrade `notifications.delivery`. */
const mailer = createSmtpMailer(store);
mailer.start();
store.listeners.add((event) => { if (event?.type === 'notification.created') mailer.enqueue(event); });

const WORKTREES = worktreeRoot();
const GLOBAL_AGENTS = path.join(HOME, '.config/workbench/AGENTS.md');

/* ---- Run lifecycle helpers (PLAN §4/§9/§16) ---- */

/* Failure classification and the retry policy live in ./failures.mjs so the
   same rules are unit-tested and reused (PLAN §40). */
const MAX_RUN_RETRIES = Math.max(0, Math.min(6, Math.floor(Number(process.env.WORKBENCH_MAX_RETRIES ?? 3)) || 0));

function emitTyped(conversationId, runId, type, payload = {}) {
  return store.event(type, conversationId, { ...payload, runId }, { kind: type, runId });
}

function setRunPhase(run, status, extra = {}) {
  status = normalizeStatus(status);
  const changed = run.phase !== status;
  run.previousPhase = run.phase;
  run.phase = status;
  run.heartbeat = Date.now();
  if (run.command?.id) store.heartbeat(run.command.id);
  if (changed) store.status(run.command.id, status, extra.error ?? null, extra.failureCode ?? null);
  if (changed || extra.force) {
    emitTyped(run.conversation.id, run.command.id, 'run.state', {
      status,
      previous: run.previousPhase || null,
      model: run.command.model,
      provider: modelInfo(run.command.model, run.conversation.engine)?.provider || null,
      started: run.started || null,
      ended: RUN_TERMINAL.includes(status) ? Date.now() : null,
      error: extra.error ?? null,
      failureCode: extra.failureCode ?? null,
    });
  }
}

function runCapacityCount() {
  return runs.size;
}

function registerInteraction(run, id, kind, data) {
  const previous = store.db.prepare('SELECT status FROM interactions WHERE id=?').get(id);
  if (previous) return;
  const runId = run.command.id;
  const questions = data?.questions || data?.options || null;
  store.db.prepare('INSERT INTO interactions(id,conversation_id,kind,data,run_id,options) VALUES (?,?,?,?,?,?)')
    .run(id, run.conversation.id, kind, JSON.stringify(data || {}), runId, questions ? JSON.stringify(questions) : null);
  run.waiting = true;
  setRunPhase(run, kind === 'permission' ? 'waiting_for_permission' : 'waiting_for_user');
  if (kind === 'permission') {
    const action = data?.action || data?.permission || null;
    const detail = data?.detail || (Array.isArray(data?.patterns) ? data.patterns[0] : null);
    emitTyped(run.conversation.id, runId, 'permission.required', { interactionId: id, action, detail });
    createNotification(store, { kind: 'permission.required', conversationId: run.conversation.id, runId, title: `Permission needed in “${run.conversation.title}”`, body: action || detail || null, severity: 'attention', attention: true });
  } else {
    emitTyped(run.conversation.id, runId, 'question.required', { interactionId: id, questions: questions || [] });
    createNotification(store, { kind: 'question.required', conversationId: run.conversation.id, runId, title: `A question is waiting in “${run.conversation.title}”`, severity: 'attention', attention: true });
  }
  store.event('interaction.created', run.conversation.id);
  void tick();
}

function closeInteraction(run, id) {
  store.db.prepare("UPDATE interactions SET status='answered' WHERE id=?").run(id);
  run.waiting = false;
  if (!run.cancelled && RUN_LIVE.includes(run.phase)) setRunPhase(run, 'running');
  void tick();
}

/* Build the hook surface handed to the runtime. Agent A may call any subset;
   unknown hooks are simply unused, and every call is defensive so a runtime
   that does not implement a hook cannot break the control plane. */
function runtimeHooks(run, command, conversation) {
  const runId = command.id;
  const conversationId = conversation.id;
  return {
    binding: (nativeId) => store.db.prepare('UPDATE conversations SET native_id=? WHERE id=?').run(nativeId, conversationId),
    nativeMessage: (id) => store.db.prepare('UPDATE commands SET native_message=? WHERE id=?').run(id, command.id),
    running: () => {
      if (run.cancelled) throw new Error('Run cancelled before dispatch.');
      setRunPhase(run, 'running');
    },
    message: (message) => persistMessage(conversationId, command.id, message),
    interaction: (id, kind, data) => registerInteraction(run, id, kind, data),
    interactionClosed: (id) => closeInteraction(run, id),
    state: (payload) => {
      const status = typeof payload === 'string' ? payload : payload?.status;
      if (!status) return;
      const extra = typeof payload === 'object' && payload ? { ...payload } : {};
      if (normalizeStatus(status) === 'failed' && extra.error && !extra.failureCode) {
        const failure = describeFailure(new Error(String(extra.error)));
        extra.failureCode = failure.code;
        extra.error = failure.message;
      }
      setRunPhase(run, status, extra);
    },
    /* Agent A dispatches already-typed Pi events; emit them verbatim. Legacy
       runtimes that only call `tool` with a loose payload still work. */
    tool: (payload = {}) => {
      if (!payload || typeof payload !== 'object') return;
      if (payload.kind === 'file.changed') return;
      const { kind, ...rest } = payload;
      const type = typeof kind === 'string' ? kind : (payload.phase === 'completed' || payload.status === 'completed' ? 'tool.completed' : 'tool.started');
      emitTyped(conversationId, runId, type, rest);
    },
    todo: (payload) => {
      const todos = Array.isArray(payload) ? payload : payload?.todos;
      if (!Array.isArray(todos)) return;
      store.db.prepare('UPDATE commands SET todos=? WHERE id=?').run(JSON.stringify(todos).slice(0, 200000), runId);
      emitTyped(conversationId, runId, 'todo.updated', { todos });
    },
    usage: (payload = {}) => {
      if (!payload || typeof payload !== 'object') return;
      const summary = {
        input: payload.input ?? payload.tokens?.input ?? null,
        output: payload.output ?? payload.tokens?.output ?? null,
        cacheRead: payload.cacheRead ?? payload.tokens?.cache?.read ?? null,
        cacheWrite: payload.cacheWrite ?? payload.tokens?.cache?.write ?? null,
        cost: payload.cost ?? null,
      };
      store.db.prepare('UPDATE commands SET summary=? WHERE id=?').run(JSON.stringify({ usage: summary }).slice(0, 100000), runId);
      emitTyped(conversationId, runId, 'usage.updated', { ...payload, kind: undefined });
    },
    question: (payload, questions) => {
      const id = payload && typeof payload === 'object' ? payload.interactionId : payload;
      const list = payload && typeof payload === 'object' ? payload.questions : questions;
      if (id) registerInteraction(run, id, 'question', { questions: list });
    },
    permission: (payload, action, detail) => {
      if (payload && typeof payload === 'object') {
        if (!payload.interactionId) return;
        registerInteraction(run, payload.interactionId, 'permission', { action: payload.action, detail: payload.detail });
      } else if (payload) {
        registerInteraction(run, payload, 'permission', { action, detail });
      }
    },
    fileChanged: (payload = {}) => emitTyped(conversationId, runId, 'file.changed', {
      path: payload.path || payload.file || null,
      change: payload.change || 'modified',
      additions: payload.additions ?? 0,
      deletions: payload.deletions ?? 0,
      toolCallId: payload.toolCallId || null,
    }),
    diff: (payload) => {
      const files = Array.isArray(payload) ? payload : (payload?.files || []);
      emitTyped(conversationId, runId, 'git.diff.updated', { worktreeId: payload?.worktreeId || run.worktree?.id || null, files });
    },
    attention: (payload = {}) => {
      const attention = payload.attention || 'none';
      store.db.prepare('UPDATE commands SET attention=? WHERE id=?').run(attention, runId);
      emitTyped(conversationId, runId, 'attention.changed', { attention });
    },
    activity: (activity) => emitTyped(conversationId, runId, 'run.activity', { activity }),
    text: (delta) => {
      if (typeof delta === 'string' && delta) emitTyped(conversationId, runId, 'text.delta', { delta });
    },
  };
}

/* ---- Providers, connections and catalog ---- */

const PROVIDER_LABELS = {
  'opencode-go': 'OpenCode Go', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google',
  'openai-codex': 'OpenAI',
  'google-vertex': 'Google Vertex', openrouter: 'OpenRouter', groq: 'Groq', mistral: 'Mistral',
  xai: 'xAI', deepseek: 'DeepSeek', 'github-copilot': 'GitHub Copilot', azure: 'Azure OpenAI',
  cerebras: 'Cerebras', together: 'Together AI', fireworks: 'Fireworks', deepinfra: 'DeepInfra',
};
const providerLabel = (id) => PROVIDER_LABELS[id] || String(id || '').split(/[-_]/).map((word) => word ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
const consoleUrl = (provider) => provider === 'opencode-go' ? 'https://opencode.ai/auth'
  : provider === 'openai' || provider === 'openai-codex' ? 'https://platform.openai.com/usage'
  : provider === 'anthropic' ? 'https://console.anthropic.com/settings/usage' : '';

async function readAuth() {
  return decode(await readFile(path.join(HOME, '.local/share/opencode/auth.json'), 'utf8').catch(() => '{}'), {});
}
async function readPiAuth() {
  return decode(await readFile(path.join(CONTROL, 'pi/auth.json'), 'utf8').catch(() => '{}'), {});
}

function describeOffering(model, engine, auth, piAuth, fetchedAt, stale = false) {
  const entry = auth[model.provider];
  const sharedOpenAIOAuth = engine === 'pi' && model.provider === 'openai-codex'
    && auth.openai?.type === 'oauth' && !piAuth['openai-codex'];
  const authKind = engine === 'opencode'
    ? (entry?.type === 'oauth' ? 'subscription' : entry?.type === 'api' ? 'api_key' : 'unknown')
    : (sharedOpenAIOAuth ? 'subscription' : piAuth[model.provider]?.type === 'oauth' ? 'subscription'
      : piAuth[model.provider] ? 'api_key' : entry?.type === 'api' ? 'api_key' : 'unknown');
  return {
    ...model,
    engine,
    connectionId: `${engine}:${model.provider}`,
    connectionLabel: providerLabel(model.provider),
    authKind,
    planLabel: engine === 'opencode' && model.provider === 'opencode-go' ? 'Go plan'
      : sharedOpenAIOAuth || (engine === 'pi' && piAuth[model.provider]?.type === 'oauth') ? 'Subscription'
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
    thinkingLevels: Array.isArray(model.thinkingLevels) ? model.thinkingLevels : model.reasoning ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['off'],
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
    const openCodeModels = oc.models();
    const piModels = openCodeModels.then((models) => {
      pi.setOpenAICatalog(models.filter((model) => model.provider === 'openai'));
      return pi.models();
    }, () => {
      pi.setOpenAICatalog([]);
      return pi.models();
    });
    const results = await Promise.allSettled([openCodeModels, piModels]);
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
    const sharedOpenAIOAuth = provider === 'openai-codex' && auth.openai?.type === 'oauth' && !piAuth[provider];
    const ownOAuth = piAuth[provider]?.type === 'oauth';
    list.push({
      id: `pi:${provider}`, engine: 'pi', provider, label: providerLabel(provider),
      auth: sharedOpenAIOAuth ? 'Shared OpenAI OAuth / subscription' : ownOAuth ? 'Pi OAuth / subscription'
        : piAuth[provider] ? 'Pi API key' : shared ? 'Shared OpenCode API key' : 'API key',
      authKind: sharedOpenAIOAuth || ownOAuth ? 'subscription' : 'api_key',
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

/* A queued follow-up admitted by the scheduler reuses the same worktree, so a
   durable apply/discard must treat it as busy until it leaves the queue. */
function conversationBusy(conversationId) {
  return !!store.db.prepare(`SELECT 1 FROM commands WHERE conversation_id=? AND status IN ('queued',${RUN_LIVE.map(() => '?').join(',')}) LIMIT 1`).get(conversationId, ...RUN_LIVE);
}

/* ---- AGENTS.md (PLAN §1.10) ---- */

const AGENTS_FILENAME = 'AGENTS.md';

async function readTextFile(file) {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

function agentsFileList(root, target) {
  const list = [{ scope: 'global', path: GLOBAL_AGENTS, label: 'Global (~/.config/workbench)' }];
  if (!root) return list;
  let base;
  try { base = canonical(root); } catch { return list; }
  list.push({ scope: 'project', path: path.join(base, AGENTS_FILENAME), label: 'Project root' });
  if (target) {
    // A relative `path` is project-relative, not control-CWD-relative.
    const current = path.resolve(base, target);
    if (current !== base && current.startsWith(`${base}${path.sep}`)) {
      let walk = base;
      for (const part of path.relative(base, current).split(path.sep).filter(Boolean)) {
        walk = path.join(walk, part);
        list.push({ scope: 'nested', path: path.join(walk, AGENTS_FILENAME), label: path.relative(base, walk) });
      }
    }
  }
  const seen = new Set();
  return list.filter((item) => { if (seen.has(item.path)) return false; seen.add(item.path); return true; });
}

async function collectAgents(projectId, target) {
  const p = projectId ? store.projects().find((candidate) => candidate.id === projectId) : null;
  const files = [];
  for (const item of agentsFileList(p?.directory || null, target)) {
    const content = await readTextFile(item.path);
    files.push({ ...item, exists: content !== null, content: content || '' });
  }
  return files;
}

/* Applicable instructions merged for the runtime context: global, project root,
   then nested AGENTS.md files from the project root down to the run directory. */
async function projectInstructions(conversation) {
  const target = conversation.root_directory || conversation.directory;
  const files = (await collectAgents(conversation.project_id, target)).filter((file) => file.exists && file.content.trim());
  if (!files.length) return '';
  return files.map((file) => `# AGENTS.md — ${file.label}\n${file.content.trim()}`).join('\n\n').slice(0, 100000);
}

/* ---- Message persistence ---- */

const persistMessage = createMessageWriter({ store, blobs: BLOBS, modelInfo });

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

let lastLegacySync = 0;

/* Native opencode sessions created outside Workbench (terminal runs) must
   show up on the next list load, and sessions continued in the terminal must
   move up by their last activity. Workbench-owned native sessions are bound
   via conversations.native_id and stay untouched. */
function syncLegacySessions(force = false) {
  if (!legacy) return;
  const now = Date.now();
  if (!force && now - lastLegacySync < 10_000) return;
  lastLegacySync = now;
  const rows = legacy.prepare('SELECT id,title,directory,parent_id,time_created,time_updated,model FROM session WHERE parent_id IS NULL').all();
  const bound = new Set(store.db.prepare('SELECT native_id FROM conversations WHERE native_id IS NOT NULL').all().map((row) => row.native_id));
  const known = new Set(store.db.prepare('SELECT id FROM conversations').all().map((row) => row.id));
  let changed = false;
  store.transaction(() => {
    for (const row of rows) {
      if (!row.directory || row.directory.startsWith('/tmp/opencode/workbench-')) continue;
      if (bound.has(row.id)) continue;
      if (!known.has(row.id)) {
        const p = store.projectFor(row.directory);
        const m = decode(row.model);
        store.db.prepare(`INSERT OR IGNORE INTO conversations(id,title,engine,directory,project_id,legacy_id,model,pinned,hidden,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(row.id, String(row.title || 'Imported conversation').slice(0, 120), 'opencode', row.directory, p?.id || null, row.id,
            m?.providerID && m?.id ? `${m.providerID}/${m.id}` : null, 0, 0, row.time_created, row.time_updated);
        changed = true;
        continue;
      }
      const current = store.db.prepare('SELECT updated FROM conversations WHERE id=?').get(row.id);
      const updates = [];
      const values = [];
      if (Number(row.time_updated || 0) > Number(current?.updated || 0)) { updates.push('updated=?'); values.push(row.time_updated); }
      if (row.title && !store.getSetting(`title.${row.id}`)) { updates.push('title=?'); values.push(String(row.title).slice(0, 120)); }
      if (updates.length) {
        store.db.prepare(`UPDATE conversations SET ${updates.join(',')} WHERE id=?`).run(...values, row.id);
        changed = true;
      }
    }
    if (changed) store.event('conversation.changed', null);
  });
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
  const bound = new Set(store.db.prepare('SELECT native_id FROM conversations WHERE native_id IS NOT NULL').all().map((item) => item.native_id));
  store.transaction(() => {
    for (const row of rows.filter((item) => !item.parent_id && !item.directory.startsWith('/tmp/opencode/workbench-') && !bound.has(item.id))) {
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
  for (const command of store.db.prepare("SELECT r.*,c.native_id,c.engine FROM commands r JOIN conversations c ON c.id=r.conversation_id WHERE r.status IN ('interrupted','interrupted_by_restart','failed','uncertain') AND c.engine='opencode' AND r.native_message IS NOT NULL").all()) {
    const messages = legacy.prepare("SELECT id,time_created,data FROM message WHERE session_id=? AND json_extract(data,'$.parentID')=? ORDER BY time_created,id").all(command.native_id, command.native_message);
    let complete = false;
    for (const row of messages) {
      const info = decode(row.data, {});
      const parts = legacy.prepare('SELECT id,data FROM part WHERE message_id=? ORDER BY time_created,id').all(row.id)
        .map((part) => ({ ...decode(part.data, {}), id: part.id }));
      persistMessage(command.conversation_id, command.id, { id: row.id, created: row.time_created, info, parts });
      if (info.time?.completed && info.finish && !['tool-calls', 'unknown'].includes(info.finish) && !info.error) complete = true;
    }
    if (complete) store.status(command.id, 'completed');
  }
}

/* ---- Scheduler ---- */

/* A build run in a Git project is isolated in a worktree.
   Read-only/plan runs and General chats run directly (§13). */
function shouldIsolate(conversation) {
  return conversation.mode === 'build';
}

async function ensureWorktree(conversation, runId) {
  const p = store.projects().find((candidate) => candidate.id === conversation.project_id);
  const selected = canonical(conversation.directory);
  if (!(await isGitRepo(selected))) return null;
  const top = await git(['-C', selected, 'rev-parse', '--show-toplevel']);
  if (top.error) throw fail('Could not resolve the Git checkout.', 409);
  const root = canonical(top.stdout.trim());
  const relative = path.relative(root, selected);
  const existing = store.db.prepare("SELECT * FROM worktrees WHERE conversation_id=? AND status IN ('active','conflict') ORDER BY created DESC LIMIT 1").get(conversation.id);
  if (existing && existsSync(existing.path)) {
    if (existing.root_directory && existing.root_directory !== root) throw fail('Recorded worktree belongs to another checkout; apply or discard it before continuing.', 409);
    store.db.prepare('UPDATE worktrees SET run_id=?, updated=? WHERE id=?').run(runId, Date.now(), existing.id);
    return { id: existing.id, path: existing.path, cwd: path.join(existing.path, relative), branch: existing.branch, baseBranch: existing.base_branch, baseCommit: existing.base_commit, root };
  }
  const worktree = await createWorktree({ projectId: p?.id || 'general', conversationId: conversation.id, runId, root });
  store.db.prepare('INSERT INTO worktrees(id,project_id,conversation_id,run_id,path,branch,base_branch,base_commit,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(worktree.id, p?.id || null, conversation.id, runId, worktree.path, worktree.branch, worktree.baseBranch, worktree.baseCommit, 'active', Date.now(), Date.now());
  store.db.prepare('UPDATE worktrees SET root_directory=? WHERE id=?').run(root, worktree.id);
  return { ...worktree, cwd: path.join(worktree.path, relative) };
}

function startRun(command) {
  const conversation = store.conversation(command.conversation_id);
  const runtime = conversation.engine === 'pi' ? pi : oc;
  const run = { command, conversation, runtime, cancelled: false, waiting: false, phase: 'queued', previousPhase: null, admittedAt: Date.now(), started: Date.now(), heartbeat: Date.now(), worktree: null, workspaceDir: conversation.directory, workspaceKind: 'inplace' };
  store.transaction(() => {
    store.db.prepare('UPDATE commands SET engine=?, provider=?, heartbeat=? WHERE id=?')
      .run(conversation.engine, modelInfo(command.model, conversation.engine)?.provider || null, Date.now(), command.id);
    setRunPhase(run, 'starting');
  });
  runs.set(conversation.id, run);
  void (async () => {
    let baseline = null;
    let runtimeConversation = conversation;
    try {
      canonical(conversation.directory);
      validateModel(command.model, conversation.engine);
      const thinkingLevels = modelInfo(command.model, conversation.engine)?.thinkingLevels || ['off'];
      if (!thinkingLevels.includes(command.thinking_level || conversation.thinking_level || 'off')) throw fail('Selected reasoning level is not supported by this model.');
      const input = decode(command.input, {});
      const attachments = attachmentsFor((input.attachments || []).map((attachment) => attachment.id));
      if (attachments.some((attachment) => attachment.mime.startsWith('image/')) && !modelInfo(command.model, conversation.engine)?.images) {
        throw fail('Selected model does not accept images. Choose a vision model.');
      }
      if (shouldIsolate(conversation)) {
        const worktree = await ensureWorktree(conversation, command.id);
        if (worktree) {
          run.worktree = worktree;
          run.workspaceDir = worktree.cwd;
          run.workspaceKind = 'worktree';
          runtimeConversation = { ...conversation, directory: worktree.cwd, root_directory: worktree.root };
          store.db.prepare('UPDATE commands SET worktree_id=? WHERE id=?').run(worktree.id, command.id);
          emitTyped(conversation.id, command.id, 'git.diff.updated', { worktreeId: worktree.id, files: [] });
        }
      }
      if (!run.worktree) baseline = await captureBaseline(run.workspaceDir);
      const handoff = !conversation.native_id ? store.getSetting(`handoff.${conversation.id}`) : null;
      let context = '';
      try { context = await projectInstructions(runtimeConversation); } catch (error) { console.warn(JSON.stringify({ event: 'instructions_failed', runId: command.id, message: error.message })); }
      /* AGENTS.md instructions ride along as command context; because the Pi
         runner does not yet consume `context`, they are also prepended to the
         prompt so they actually reach the model. The stored user message keeps
         the original text. */
      const prefix = context.trim() ? `Project instructions (AGENTS.md) that apply to this request:\n${context.trim()}\n\n---\n\n` : '';
      const baseText = handoff ? `Previous conversation context (reference only):\n${handoff}\n\nCurrent request:\n${input.text}` : input.text;
      const runtimeCommand = { ...command, reasoning: command.thinking_level || conversation.thinking_level || 'off', input: JSON.stringify({ ...input, text: `${prefix}${baseText}` }), context, instructions: context };
      if (run.cancelled) throw Object.assign(new Error('Run cancelled before dispatch.'), { cancelled: true });
      await runtime.run(runtimeConversation, runtimeCommand, attachments, runtimeHooks(run, command, conversation));
      if (run.cancelled) {
        setRunPhase(run, 'cancelled');
      } else {
        // Finish Git inspection before admitting a follow-up in this worktree.
        try {
          const summary = run.worktree ? await worktreeChanges(run.worktree) : await summarizeChanges(run.workspaceDir, baseline);
          if (summary) {
            store.db.prepare('INSERT OR REPLACE INTO artifacts VALUES (?,?,?)').run(`changes_${command.id}`, conversation.id, JSON.stringify(summary));
            if (run.worktree) emitTyped(conversation.id, command.id, 'git.diff.updated', { worktreeId: run.worktree.id, files: summary.files });
          }
        } catch (error) { console.warn(JSON.stringify({ event: 'changes_failed', runId: command.id, message: error.message })); }
        setRunPhase(run, run.cancelled ? 'cancelled' : 'completed');
        if (!run.cancelled) createNotification(store, { kind: 'run.completed', conversationId: conversation.id, runId: command.id, title: `“${conversation.title}” finished`, severity: 'success' });
        void maybeGenerateTitle(conversation.id).catch(error => console.warn(JSON.stringify({ event: 'title_failed', conversationId: conversation.id, message: error.message })));
      }
    } catch (error) {
      if (run.cancelled) {
        setRunPhase(run, 'cancelled', { error: null, failureCode: null });
      } else {
        const failure = describeFailure(error);
        const attempts = Number(store.db.prepare('SELECT attempts FROM commands WHERE id=?').get(command.id)?.attempts || 0);
        if (!shuttingDown && failure.code && RETRYABLE_CODES.has(failure.code) && attempts < MAX_RUN_RETRIES) {
          /* Transient provider/network failure: requeue with exponential backoff
             instead of ending the run and pausing the conversation. */
          const attempt = attempts + 1;
          const delay = retryDelay(attempt);
          store.retry(command.id, attempt, Date.now() + delay);
          emitTyped(conversation.id, command.id, 'run.retry', { attempt, delayMs: delay, failureCode: failure.code, error: failure.message });
          console.warn(JSON.stringify({ event: 'run_retry', conversationId: conversation.id, runId: command.id, attempt, delayMs: delay, failureCode: failure.code, message: String(error?.message || error).slice(0, 300) }));
          const timer = setTimeout(() => { if (!shuttingDown) void tick(); }, delay + 50);
          timer.unref?.();
        } else {
          setRunPhase(run, 'failed', { error: failure.message, failureCode: failure.code });
          createNotification(store, { kind: 'run.failed', conversationId: conversation.id, runId: command.id, title: `“${conversation.title}” failed`, body: failure.message, severity: 'error' });
          console.warn(JSON.stringify({ event: 'run_failed', conversationId: conversation.id, runId: command.id, failureCode: failure.code, message: String(error?.message || error).slice(0, 500) }));
        }
      }
    } finally {
      runs.delete(conversation.id);
      void tick();
    }
  })();
}

const { tick, metrics: schedulerMetrics } = createScheduler({ store, runs, startRun, maxRuns,
  reserveMB: MIN_FREE_MB, perRunMB: MEM_PER_RUN_MB, stopping: () => shuttingDown });

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
  return matchesSecret(req.headers['x-workbench-internal-key'], key);
}

async function upload(req, res, url) {
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 50 * 1024 * 1024) throw fail('Each attachment must be at most 50 MB.', 413);
    chunks.push(chunk);
  }
  if (!size) throw fail('Empty attachment.');
  const bytes = Buffer.concat(chunks);
  const hex = bytes.subarray(0, 12).toString('hex');
  // Only images are sniffed: a mislabeled image would otherwise reach the model
  // as a broken vision input. Everything else is stored opaquely and handed to
  // the agent as a file on disk.
  if ((mime === 'image/png' && !hex.startsWith('89504e470d0a1a0a'))
    || (mime === 'image/jpeg' && !hex.startsWith('ffd8ff'))
    || (mime === 'image/gif' && !bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/))
    || (mime === 'image/webp' && !(bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'))) {
    throw fail('File content does not match its image type.', 415);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const id = uid('att_');
  const requested = String(url.searchParams.get('name') || '').slice(0, 200);
  const ext = safeExtension(requested, mime);
  const filename = `${hash}.${ext}`;
  await writeFile(path.join(BLOBS, filename), bytes, { mode: 0o600 });
  const name = requested || `attachment.${ext}`;
  store.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?,?)').run(id, name, mime, size, hash, filename, Date.now());
  json(res, 201, { attachment: { id, name, mime, bytes: size, url: `/api/v2/attachments/${id}` } });
}

const MIME_EXTENSIONS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/gzip': 'gz', 'application/x-tar': 'tar',
};
// Prefer the uploaded name's own extension; fall back to the mime table, then
// "bin". Sanitised so it can never break out of the blob filename.
function safeExtension(name, mime) {
  const fromName = (String(name).match(/\.([A-Za-z0-9]{1,12})$/) || [])[1];
  if (fromName) return fromName.toLowerCase();
  return MIME_EXTENSIONS[mime] || 'bin';
}

async function routes(req, res) {
  if (!(await authenticate(req))) return json(res, 403, { error: 'Forbidden.' });
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/^\/api\/v2/, '');
  const method = req.method;

  if (route === '/health') return json(res, 200, { ok: true, version: 3, runs: [...runs.values()].map((run) => ({ conversationId: run.conversation.id, commandId: run.command.id, phase: run.phase, waiting: run.waiting, worktreeId: run.worktree?.id || null })), maxRuns: maxRuns(), active: runCapacityCount(), queued: store.queued(), worktrees: WORKTREES,
    metrics: { scheduler: schedulerMetrics, store: store.metrics, events: store.db.prepare('SELECT count(*) AS n FROM events').get().n, listeners: store.listeners.size, memory: process.memoryUsage(), uptime: process.uptime() } });
  if (route === '/events' && method === 'GET') return streamEvents(store, req, res, url);

  if (route === '/bootstrap' && method === 'GET') {
    maintenance('legacy_sync', () => syncLegacySessions());
    const list = store.list({ limit: 60 });
    return json(res, 200, {
      ...list,
      sessions: list.sessions.map(withCapabilities),
      projects: store.projects(),
      connections: await connections(),
      seq: store.sequence(),
      defaults: { opencode: defaultModel('opencode'), pi: defaultModel('pi') },
      engines: ['opencode', 'pi'],
      defaultEngine: store.getSetting('default.engine') || 'pi',
      capabilities: CAPABILITIES,
      maxRuns: maxRuns(),
      openTabs: store.getSetting('openTabs', null),
      active: runCapacityCount(),
      queued: store.queued(),
      worktrees: WORKTREES,
      notifications: Number(store.db.prepare('SELECT count(*) AS n FROM notifications WHERE read=0').get().n),
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
    /* Best-effort cleanup of any isolated worktrees before the project row goes
       away; the user's original checkout is never touched. Discard against the
       checkout the worktree was recorded from and keep the row when removal
       fails so the directory is not leaked. */
    for (const row of store.db.prepare('SELECT * FROM worktrees WHERE project_id=?').all(p.id)) {
      try {
        await discardWorktree({ id: row.id, path: row.path, branch: row.branch, baseCommit: row.base_commit }, row.root_directory || p.directory);
        store.db.prepare('DELETE FROM worktrees WHERE id=?').run(row.id);
      } catch (error) {
        console.warn(JSON.stringify({ event: 'project_worktree_cleanup_failed', projectId: p.id, worktreeId: row.id, message: error.message }));
      }
    }
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
  if (route === '/settings' && method === 'GET') {
    return json(res, 200, {
      maxRuns: maxRuns(),
      defaultMaxRuns: DEFAULT_MAX_RUNS,
      maxRunsLimit: MAX_RUNS_LIMIT,
      active: runCapacityCount(),
      queued: store.queued(),
      defaults: { opencode: defaultModel('opencode'), pi: defaultModel('pi') },
      defaultEngine: store.getSetting('default.engine') || 'pi',
      favorites: store.getSetting('favorites', []),
      openTabs: store.getSetting('openTabs', null),
      smtp: publicSmtpConfig(store),
    });
  }
  if (route === '/settings' && method === 'POST') {
    const b = await body(req);
    if (b.defaultModel) {
      const engine = b.engine === 'pi' ? 'pi' : 'opencode';
      validateModel(b.defaultModel, engine);
      store.setSetting(`default.${engine}`, b.defaultModel);
    }
    if (b.defaultEngine === 'opencode' || b.defaultEngine === 'pi') store.setSetting('default.engine', b.defaultEngine);
    if (Array.isArray(b.favorites)) store.setSetting('favorites', b.favorites.filter((value) => typeof value === 'string').slice(0, 100));
    if (b.openTabs !== undefined) {
      /* Cross-device working set. Tolerant of unknown
         ids: the client reconciles them on bootstrap. */
      const tabs = b.openTabs || {};
      const order = (Array.isArray(tabs.order) ? tabs.order : []).filter((value) => typeof value === 'string' && value).slice(0, 64);
      const pinned = (Array.isArray(tabs.pinned) ? tabs.pinned : []).filter((value) => typeof value === 'string' && order.includes(value));
      const activeId = typeof tabs.activeId === 'string' && order.includes(tabs.activeId) ? tabs.activeId : null;
      store.setSetting('openTabs', { order, pinned, activeId });
    }
    if (b.maxRuns !== undefined) {
      const value = Number(b.maxRuns);
      if (!Number.isInteger(value) || value < MIN_RUNS || value > MAX_RUNS_LIMIT) throw fail(`maxRuns must be an integer between ${MIN_RUNS} and ${MAX_RUNS_LIMIT}.`);
      store.setSetting('maxRuns', value);
      store.event('settings.changed', null, { maxRuns: value }, { kind: 'settings.changed' });
      /* A raised limit should drain the queue without waiting for the next tick. */
      void tick();
    }
    if (b.smtp !== undefined) {
      saveSmtpConfig(store, b.smtp);
      store.event('settings.changed', null, { smtp: true }, { kind: 'settings.changed' });
    }
    if (b.defaultModel === undefined && b.defaultEngine === undefined && b.favorites === undefined && b.maxRuns === undefined && b.smtp === undefined) {
      return json(res, 200, { ok: true, maxRuns: maxRuns(), smtp: publicSmtpConfig(store) });
    }
    store.event('models.changed', null);
    return json(res, 200, { ok: true, maxRuns: maxRuns(), smtp: publicSmtpConfig(store) });
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
    void refreshCatalog().catch(() => {});
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
    void refreshCatalog().catch(() => {});
    return json(res, 200, { connected: true });
  }

  if (route === '/conversations' && method === 'GET') {
    syncLegacySessions();
    const result = store.list({ projectId: url.searchParams.get('projectId') ?? undefined, q: (url.searchParams.get('q') || '').slice(0, 200), before: url.searchParams.get('cursor') || undefined, hidden: url.searchParams.get('hidden') === 'true' });
    return json(res, 200, { ...result, sessions: result.sessions.map(withCapabilities) });
  }
  if (route === '/conversations' && method === 'POST') {
    const b = await body(req);
    /* Pi is the default engine; OpenCode remains available as an explicit,
       advanced adapter (PLAN §1.1). */
    const engine = b.engine === 'opencode' ? 'opencode' : 'pi';
    const requestedProject = project(b.projectId);
    const directory = canonical(b.workspace || b.directory || requestedProject?.directory || GENERAL);
    const p = store.projectFor(directory);
    if (requestedProject && p?.id !== requestedProject.id) throw fail('Choose a workspace belonging to this project.');
    const id = b.id || uid('chat_');
    if (!/^[\w-]{8,100}$/.test(id)) throw fail('Invalid conversation ID.');
    const existing = store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if (existing) {
      if (existing.engine !== engine || existing.project_id !== (p?.id || null)) throw fail('Conversation ID conflict.', 409);
      return json(res, 200, { session: withCapabilities(store.view(existing)) });
    }
    const chosen = b.model || defaultModel(engine, p?.id);
    if (!chosen && engine === 'pi') throw fail('No Pi model is available yet. Connect a provider API key, or start an OpenCode (advanced) chat.', 409);
    const model = validateModel(chosen, engine);
    const session = store.createConversation({ id, title: String(b.title || 'New conversation'), engine, directory, projectId: p?.id || null, model, mode: b.mode === 'plan' ? 'plan' : 'build' });
    return json(res, 201, { session: withCapabilities(store.view(session)) });
  }

  const promptsMatch = /^\/conversations\/([^/]+)\/prompts$/.exec(route);
  if (promptsMatch && method === 'GET') {
    const c = store.conversation(promptsMatch[1]);
    const byId = new Map();
    /* Only user turns are needed, and the newest window is enough for the
       prompt navigation list; filtering in SQL avoids decoding every row. */
    const promptRows = store.db.prepare(`SELECT id,created,data FROM messages
      WHERE conversation_id=? AND json_extract(data,'$.info.role')='user'
      ORDER BY created DESC,id DESC LIMIT 500`).all(c.id);
    for (const row of promptRows) {
      const message = decode(row.data, {});
      const text = (message.parts || []).filter((part) => part.type === 'text').map((part) => part.text || '').join(' ').replace(/\s+/g, ' ').trim();
      byId.set(message.id, { id: message.id, preview: text.slice(0, 100), created: row.created });
    }
    if (c.legacy_id && legacy) {
      const rows = legacy.prepare(`SELECT m.id AS id, m.time_created AS created, json_extract(p.data,'$.text') AS text
        FROM message m JOIN part p ON p.message_id=m.id
        WHERE m.session_id=? AND json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text'
        ORDER BY m.time_created ASC, p.time_created ASC`).all(c.legacy_id);
      for (const row of rows) {
        if (byId.has(row.id)) continue;
        const preview = String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        byId.set(row.id, { id: row.id, preview, created: row.created });
      }
    }
    const prompts = [...byId.values()].sort((a, b) => Number(a.created || 0) - Number(b.created || 0));
    return json(res, 200, { prompts });
  }

  const steerMatch = /^\/conversations\/([^/]+)\/steer$/.exec(route);
  if (steerMatch && method === 'POST') {
    const c = store.conversation(steerMatch[1]);
    const b = await body(req);
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text) throw fail('Write a message to steer with.');
    if (text.length > 60000) throw fail('Message must be under 60,000 characters.');
    const run = runs.get(c.id);
    if (run && c.engine === 'pi' && typeof run.runtime?.steer === 'function' && await run.runtime.steer(c.id, text)) {
      store.message(c.id, { id: `steer_${uid()}`, created: Date.now(), info: { role: 'user', steer: true }, parts: [{ id: uid('txt_'), type: 'text', text }] });
      emitTyped(c.id, run.command.id, 'steer.delivered', { text });
      return json(res, 202, { steered: true });
    }
    /* No live Pi worker to steer: keep it durable and let the queue run it. */
    const model = validateModel(b.model || c.model || defaultModel(c.engine, c.project_id), c.engine);
    const command = store.accept(c.id, { text, attachments: [] }, model, c.thinking_level || 'off', b.clientCommandId || uid());
    json(res, 202, { steered: false, queued: true, commandId: command.id });
    void tick();
    return;
  }

  const conversationMatch = /^\/conversations\/([^/]+)$/.exec(route);
  if (conversationMatch) {
    const c = store.conversation(conversationMatch[1]);
    if (method === 'GET') return json(res, 200, { session: withCapabilities(store.view(c, messagesPage(c, url.searchParams.get('before')))) });
    if (method === 'DELETE') {
      if (runs.has(c.id)) throw fail('Stop the running agent before deleting this conversation.', 409);
      for (const row of store.db.prepare("SELECT * FROM worktrees WHERE conversation_id=? AND status IN ('active','conflict')").all(c.id)) {
        await discardWorktree({ id: row.id, path: row.path, branch: row.branch, baseCommit: row.base_commit }, row.root_directory || c.directory);
        store.db.prepare("UPDATE worktrees SET status='discarded',updated=? WHERE id=?").run(Date.now(), row.id);
      }
      store.removeConversation(c.id);
      return json(res, 200, { deleted: true });
    }
    if (method === 'PATCH') {
      const b = await body(req);
      if (b.model) validateModel(b.model, c.engine);
      if (b.thinkingLevel !== undefined) { const model = b.model || c.model; const levels = modelInfo(model, c.engine)?.thinkingLevels || ['off']; if (!levels.includes(b.thinkingLevel)) throw fail('Choose a reasoning level supported by this model.'); }
      if ('projectId' in b || 'workspace' in b || 'directory' in b) {
        if (runs.has(c.id) || store.active(c.id) || store.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND status='queued'").get(c.id)) throw fail('Finish or remove queued work before changing workspace.', 409);
        if (b.revision !== undefined && b.revision !== c.revision) throw fail('Conversation changed; refresh before changing workspace.', 409);
        const p = 'projectId' in b ? project(b.projectId) : (c.project_id ? project(c.project_id) : null);
        const requested = b.workspace || b.directory;
        if (requested) {
          const directory = canonical(requested);
          if (p && store.projectFor(directory)?.id !== p.id) throw fail('Choose a workspace belonging to this project.');
          b.directory = directory;
        } else {
          b.directory = p ? canonical(p.directory) : GENERAL;
        }
        b.projectId = store.projectFor(b.directory)?.id || null;
        /* Rebinding a conversation invalidates its isolated worktree(s). */
        for (const row of store.db.prepare("SELECT * FROM worktrees WHERE conversation_id=? AND status IN ('active','conflict')").all(c.id)) {
          await discardWorktree({ id: row.id, path: row.path, branch: row.branch, baseCommit: row.base_commit }, row.root_directory || c.directory);
          store.db.prepare("UPDATE worktrees SET status='discarded',updated=? WHERE id=?").run(Date.now(), row.id);
        }
        store.db.prepare('UPDATE conversations SET native_id=NULL WHERE id=?').run(c.id);
      }
      if ('title' in b) {
        if (typeof b.title !== 'string' || !b.title.trim()) throw fail('Title is required.');
        b.title = b.title.trim().slice(0, 120);
        store.setSetting(`title.${c.id}`, 'manual');
      }
      const previousModel = c.model;
      const session = store.patchConversation(c.id, b, b.revision);
      /* Model switch is durable: old messages keep their own model in `info`,
         new runs use the new model, and a system message records the change. */
      if (b.thinkingLevel !== undefined && b.thinkingLevel !== c.thinking_level) emitTyped(c.id, null, 'model.changed', { thinkingLevel: b.thinkingLevel, engine: c.engine });
      if (b.model && b.model !== previousModel) {
        const next = modelInfo(b.model, c.engine);
        const previous = modelInfo(previousModel, c.engine);
        const label = (m) => m ? `${m.name || m.id} (${m.provider})` : 'none';
        store.message(c.id, {
          id: uid('sys_'), created: Date.now(), info: { role: 'system', modelID: next?.id, providerID: next?.provider },
          parts: [{ id: uid('txt_'), type: 'text', text: `Model changed from ${label(previous)} to ${label(next)}.` }],
        });
        emitTyped(c.id, null, 'model.changed', { from: previousModel, to: b.model, provider: next?.provider || null, engine: c.engine });
      }
      return json(res, 200, { session: withCapabilities(session) });
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
    const availableThinking = modelInfo(model, c.engine)?.thinkingLevels || ['off'];
    const thinkingLevel = b.thinkingLevel || c.thinking_level || 'off';
    if (!availableThinking.includes(thinkingLevel)) throw fail('Choose a reasoning level supported by this model.', 409);
    if (attachments.some((attachment) => attachment.mime.startsWith('image/')) && !modelInfo(model, c.engine)?.images) throw fail('Select a model that supports images.', 409);
    /* Sending a message is an explicit intent to continue: a queue paused by
       Stop or by a failed/interrupted run must not swallow it silently. */
    if (c.paused) store.patchConversation(c.id, { paused: false });
    const command = store.accept(c.id, { text, attachments: attachments.map(({ id, name, mime }) => ({ id, name, mime })) }, model, thinkingLevel, b.clientCommandId);
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
        setRunPhase(run, 'interrupting');
        await run.runtime.stop(c.id);
      } else {
        const active = store.active(c.id);
        if (active) store.status(active.id, 'cancelled');
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
    if (method === 'GET') return json(res, 200, { id: command.id, status: command.status, conversationId: command.conversation_id, error: command.error || null, failureCode: command.failure_code || null });
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
    if (!['failed', 'interrupted', 'interrupted_by_restart', 'cancelled'].includes(command.status)) throw fail('Only a finished command can be retried.', 409);
    const conversation = store.conversation(command.conversation_id);
    if (conversation.paused) store.patchConversation(conversation.id, { paused: false });
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
    const conversation = store.conversation(interaction.conversation_id);
    const runtime = conversation.engine === 'pi' ? pi : oc;
    if (typeof runtime.respond !== 'function') throw fail('This engine does not support interactive requests yet.', 409);
    store.db.prepare("UPDATE interactions SET status='responding' WHERE id=? AND status='pending'").run(interaction.id);
    try {
      await runtime.respond(conversation, interaction, b);
      const run = runs.get(interaction.conversation_id);
      if (run) closeInteraction(run, interaction.id);
      else {
        store.db.prepare("UPDATE interactions SET status='answered' WHERE id=?").run(interaction.id);
        store.event('interaction.answered', interaction.conversation_id);
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
    const stream = createReadStream(path.join(BLOBS, attachment.filename));
    stream.on('error', () => { if (!res.headersSent) json(res, 404, { error: 'Attachment not found.' }); else res.destroy(); });
    res.writeHead(200, { 'content-type': attachment.mime, 'content-length': attachment.bytes, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    return stream.pipe(res);
  }
  const artifactMatch = /^\/artifacts\/([^/]+)$/.exec(route);
  if (artifactMatch && method === 'GET') {
    const artifact = store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(artifactMatch[1]);
    if (!artifact) {
      const part = legacy && artifactMatch[1].startsWith('tool_') ? legacy.prepare('SELECT data FROM part WHERE id=?').get(artifactMatch[1].slice(5)) : null;
      if (part) return json(res, 200, { artifact: decode(part.data, {}).state || {} });
      throw fail('Artifact not found.', 404);
    }
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
    const requested = String(url.searchParams.get('path') || '');
    if (!requested) throw fail('A file path is required.');
    let target;
    try { target = realpathSync(path.resolve(root, requested)); } catch { throw fail('File not found.', 404); }
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw fail('That file is outside the project.', 400);
    const info = statSync(target);
    if (!info.isFile() || info.size > 1024 * 1024) throw fail('Choose a file smaller than 1 MB.', 413);
    const extension = path.extname(target).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/markdown', '.json': 'application/json' }[extension] || 'text/plain';
    const stream = createReadStream(target);
    stream.on('error', () => { if (!res.headersSent) json(res, 404, { error: 'File not found.' }); else res.destroy(); });
    res.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff' });
    return stream.pipe(res);
  }

  /* ---- Git worktrees (PLAN §12/§13) ---- */

  const worktreeRecord = (row) => ({
    id: row.id, path: row.path, branch: row.branch, baseBranch: row.base_branch, baseCommit: row.base_commit,
    projectId: row.project_id, conversationId: row.conversation_id, runId: row.run_id,
  });
  const worktreeByRun = (runId) => store.db.prepare('SELECT * FROM worktrees WHERE run_id=? ORDER BY created DESC LIMIT 1').get(runId)
    || store.db.prepare('SELECT * FROM worktrees WHERE id=?').get(runId);
  const worktreeRootFor = (row) => {
    if (row.root_directory) return canonical(row.root_directory);
    const p = store.projects().find((candidate) => candidate.id === row.project_id);
    if (!p) throw fail('Project not found.', 404);
    return canonical(p.directory);
  };

  if (route === '/worktrees' && method === 'GET') {
    const clauses = [];
    const args = [];
    if (url.searchParams.get('projectId')) { clauses.push('project_id=?'); args.push(url.searchParams.get('projectId')); }
    if (url.searchParams.get('status')) { clauses.push('status=?'); args.push(url.searchParams.get('status')); }
    const rows = store.db.prepare(`SELECT * FROM worktrees ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created DESC LIMIT 200`).all(...args);
    return json(res, 200, { root: WORKTREES, worktrees: rows.map((row) => ({ ...worktreeRecord(row), status: row.status, error: row.error || null, created: row.created, updated: row.updated })) });
  }

  const runChangesMatch = /^\/runs\/([^/]+)\/changes$/.exec(route);
  const conversationChangesMatch = /^\/conversations\/([^/]+)\/changes$/.exec(route);
  if ((runChangesMatch || conversationChangesMatch) && method === 'GET') {
    const row = runChangesMatch ? worktreeByRun(runChangesMatch[1])
      : store.db.prepare('SELECT * FROM worktrees WHERE conversation_id=? ORDER BY created DESC LIMIT 1').get(conversationChangesMatch[1]);
    if (!row) return json(res, 200, { status: 'none', files: [], additions: 0, deletions: 0, patch: '' });
    const info = await worktreeChanges(worktreeRecord(row), { includePatch: url.searchParams.get('patch') === '1' });
    return json(res, 200, { ...info, status: info.status === 'missing' ? 'missing' : row.status, error: row.error || null });
  }

  const runApplyMatch = /^\/runs\/([^/]+)\/apply$/.exec(route);
  if (runApplyMatch && method === 'POST') {
    const row = worktreeByRun(runApplyMatch[1]);
    if (!row) throw fail('No worktree is recorded for this run.', 404);
    /* Guard on the durable command status, not the in-memory map: a run is
       recorded terminal before its worker leaves `runs`, so the map would
       reject a legitimate apply/discard in that window. */
    if (conversationBusy(row.conversation_id)) throw fail('Wait for the run to finish before applying its changes.', 409);
    const result = await applyWorktree(worktreeRecord(row), worktreeRootFor(row));
    if (result.status === 'conflict') {
      store.db.prepare("UPDATE worktrees SET status='conflict',error=?,updated=? WHERE id=?").run(result.error || 'The changes no longer apply cleanly.', Date.now(), row.id);
      emitTyped(row.conversation_id, row.run_id, 'git.diff.updated', { worktreeId: row.id, files: result.files });
      return json(res, 200, { status: 'conflict', error: result.error, files: result.files });
    }
    store.db.prepare("UPDATE worktrees SET status='applied',error=NULL,updated=? WHERE id=?").run(Date.now(), row.id);
    emitTyped(row.conversation_id, row.run_id, 'git.diff.updated', { worktreeId: row.id, files: result.files });
    return json(res, 200, { status: 'applied', files: result.files, additions: result.additions, deletions: result.deletions });
  }

  const runDiscardMatch = /^\/runs\/([^/]+)\/discard$/.exec(route);
  if (runDiscardMatch && method === 'POST') {
    const row = worktreeByRun(runDiscardMatch[1]);
    if (!row) throw fail('No worktree is recorded for this run.', 404);
    if (conversationBusy(row.conversation_id)) throw fail('Wait for the run to finish before discarding its changes.', 409);
    await discardWorktree(worktreeRecord(row), worktreeRootFor(row));
    store.db.prepare("UPDATE worktrees SET status='discarded',error=NULL,updated=? WHERE id=?").run(Date.now(), row.id);
    emitTyped(row.conversation_id, row.run_id, 'git.diff.updated', { worktreeId: row.id, files: [] });
    return json(res, 200, { status: 'discarded' });
  }

  /* ---- AGENTS.md (PLAN §1.10) ---- */

  if (route === '/agents-md' && method === 'GET') {
    const projectId = url.searchParams.get('projectId');
    const target = url.searchParams.get('path') || null;
    const files = await collectAgents(projectId && projectId !== 'general' ? projectId : null, target);
    return json(res, 200, {
      files,
      global: files.find((file) => file.scope === 'global')?.content || '',
      project: files.find((file) => file.scope === 'project')?.content || '',
    });
  }
  if (route === '/agents-md' && method === 'POST') {
    const b = await body(req);
    const content = typeof b.content === 'string' ? b.content : '';
    if (content.length > 256000) throw fail('AGENTS.md must be at most 256,000 characters.');
    let file;
    if (b.scope === 'global') {
      file = GLOBAL_AGENTS;
    } else {
      const p = project(b.projectId);
      if (!p) throw fail('Project not found.', 404);
      const root = canonical(p.directory);
      const requested = String(b.path || AGENTS_FILENAME);
      file = path.resolve(root, requested);
      if (path.basename(file) !== AGENTS_FILENAME) throw fail('Only AGENTS.md files can be edited.');
      /* Lexical containment is not enough: a directory symlink inside the
         project can point outside it. Resolve existing ancestors first. */
      if (!insideDir(resolvedPath(root), resolvedPath(file))) throw fail('That file is outside the project.', 400);
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${uid()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, file);
    store.event('agents.changed', null, { path: file, scope: b.scope === 'global' ? 'global' : 'project' }, { kind: 'agents.changed' });
    return json(res, 200, { saved: true, path: file, scope: b.scope === 'global' ? 'global' : 'project' });
  }

  /* ---- Usage limits and pacing (PLAN §30–§32) ---- */

  if (route === '/usage/limits' && method === 'GET') return json(res, 200, { limits: listLimits(store) });
  if (route === '/usage/limits' && method === 'POST') {
    const b = await body(req);
    if (b.delete && b.id) return json(res, 200, removeLimit(store, String(b.id)));
    const limit = upsertLimit(store, b);
    store.event('usage.limits.changed', null, { limitId: limit.id }, { kind: 'usage.limits.changed' });
    return json(res, 201, { limit });
  }
  if (route === '/usage/pacing' && method === 'GET') return json(res, 200, { pacing: pacing(store), generatedAt: Date.now() });
  const usageLimitMatch = /^\/usage\/limits\/([^/]+)$/.exec(route);
  if (usageLimitMatch && method === 'DELETE') {
    const result = removeLimit(store, usageLimitMatch[1]);
    store.event('usage.limits.changed', null, { limitId: usageLimitMatch[1] }, { kind: 'usage.limits.changed' });
    return json(res, 200, result);
  }

  /* ---- Notifications (PLAN §33) ---- */

  if (route === '/notifications' && method === 'GET') {
    return json(res, 200, listNotifications(store, { unreadOnly: url.searchParams.get('unread') === 'true', limit: Number(url.searchParams.get('limit')) || 100 }));
  }
  const notificationReadMatch = /^\/notifications\/([^/]+)\/read$/.exec(route);
  if (notificationReadMatch && method === 'POST') {
    return json(res, 200, { notification: markNotificationRead(store, notificationReadMatch[1]) });
  }
  const notificationMatch = /^\/notifications\/([^/]+)$/.exec(route);
  if (notificationMatch && method === 'PATCH') {
    return json(res, 200, { notification: markNotificationRead(store, notificationMatch[1]) });
  }
  if (route === '/notifications/read-all' && method === 'POST') {
    const b = await body(req).catch(() => ({}));
    return json(res, 200, markAllNotificationsRead(store, b?.conversationId || null));
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

  throw fail('Not found.', 404);
}

importProjects();
maintenance('legacy_import', importLegacy);
maintenance('legacy_sync', () => syncLegacySessions(true));
store.recover();
await seedCatalog();
pi.setOpenAICatalog(catalog.filter((model) => model.provider === 'openai'));
await importClips();
maintenance('legacy_recovery', reconcileRecordedRuns);

const server = createServer((req, res) => {
  routes(req, res).catch((error) => {
    console.error(JSON.stringify({ event: 'request_error', path: req.url?.split('?')[0], message: error.message }));
    if (!res.headersSent) json(res, error.status || 500, { error: error.message });
    else res.destroy();
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(Number(process.env.WORKBENCH_CONTROL_PORT || 8788), '127.0.0.1', () => console.log(JSON.stringify({ event: 'control_ready', port: Number(process.env.WORKBENCH_CONTROL_PORT || 8788), maxRuns: maxRuns() })));

const scheduler = setInterval(() => void tick(), 2000);
scheduler.unref();
/* Lease heartbeat: while this process lives, its runs are provably alive. On
   restart the next control process sees stale live runs and marks them
   interrupted_by_restart (store.recover). */
const heartbeat = setInterval(() => {
  for (const run of runs.values()) {
    run.heartbeat = Date.now();
    store.heartbeat(run.command.id);
  }
}, 10000);
heartbeat.unref();
const legacySync = setInterval(() => maintenance('legacy_sync', () => syncLegacySessions(true)), 30_000);
legacySync.unref();
sampleSystem();
const systemSampler = setInterval(sampleSystem, SYSTEM_SAMPLE_MS);
systemSampler.unref();
const prune = setInterval(() => maintenance('prune', () => {
  store.pruneEvents();
  store.db.prepare('DELETE FROM artifacts WHERE length(data)<2 OR conversation_id NOT IN (SELECT id FROM conversations)').run();
  store.checkpoint();
}), 60000);
prune.unref();

/* Worktree retention: applied/discarded worktrees are throwaway once the user
   has decided; keep them briefly, then remove the directory and branch so disk
   does not grow without bound. Active/conflict worktrees are never touched. */
const WORKTREE_RETENTION_MS = Math.max(0, Number(process.env.WORKBENCH_WORKTREE_RETENTION_MS || 3 * 86400000));
async function maintainWorktrees() {
  let rows;
  try {
    rows = store.db.prepare("SELECT * FROM worktrees WHERE status IN ('applied','discarded') AND updated<?").all(Date.now() - WORKTREE_RETENTION_MS);
  } catch (error) {
    console.warn(JSON.stringify({ event: 'worktree_gc_failed', message: error.message }));
    return;
  }
  let removed = 0;
  for (const row of rows) {
    try {
      const root = row.root_directory || store.projects().find((p) => p.id === row.project_id)?.directory;
      if (root && existsSync(root)) await discardWorktree({ id: row.id, path: row.path, branch: row.branch, baseCommit: row.base_commit }, canonical(root));
      store.db.prepare('DELETE FROM worktrees WHERE id=?').run(row.id);
      removed++;
    } catch (error) { console.warn(JSON.stringify({ event: 'worktree_gc_failed', worktreeId: row.id, message: error.message })); }
  }
  if (removed) console.log(JSON.stringify({ event: 'worktree_gc', removed }));
}
const worktreeGc = setInterval(() => maintenance('worktree_gc', () => { maintainWorktrees().catch((error) => console.warn(JSON.stringify({ event: 'worktree_gc_failed', message: error.message }))); }), 3600_000);
worktreeGc.unref();
void refreshCatalog().catch((error) => console.warn(error.message));

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(scheduler);
  clearInterval(systemSampler);
  clearInterval(heartbeat);
  clearInterval(legacySync);
  clearInterval(prune);
  clearInterval(worktreeGc);
  /* Graceful drain: give active workers a moment to finish instead of
     interrupting them the instant the process is asked to stop. Waiting runs
     (question/permission) cannot drain and are interrupted after the grace. */
  const graceMs = Math.max(0, Number(process.env.WORKBENCH_SHUTDOWN_GRACE_MS || 45_000));
  if (runs.size > 0 && graceMs > 0) {
    console.log(JSON.stringify({ event: 'shutdown_draining', runs: runs.size, graceMs }));
    const deadline = Date.now() + graceMs;
    while (runs.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  for (const run of runs.values()) {
    run.cancelled = true;
    store.status(run.command.id, 'interrupted', 'Runner service stopped.');
  }
  oc.close();
  pi.close();
  mailer.stop();
  server.close();
  for (const listener of store.listeners) store.listeners.delete(listener);
  setTimeout(() => { store.close(); legacy?.close(); process.exit(0); }, 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
