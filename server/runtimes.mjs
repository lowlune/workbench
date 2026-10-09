import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, fail } from './store.mjs';
import { sandboxSpawn, signalGroup, terminateGroup } from './security.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* Small text-ish attachments are inlined into the prompt; anything else is left
   on disk and the agent is told the path so it can read/process it itself. */
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|x-sh|x-ndjson|toml|sql|graphql|x-httpd-php))/;
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});

export const CAPABILITIES = {
  opencode: { images: true, files: true, questions: true, permissions: true, usage: true, fork: true, modes: true, plan: true },
  pi: { images: true, files: true, questions: true, permissions: true, usage: true, fork: true, modes: true, plan: true },
};

function dispatchPiEvent(event, hooks) {
  switch (event.kind) {
    case 'tool.started':
    case 'tool.completed':
    case 'tool.progress':
    case 'command.started':
    case 'command.completed':
    case 'file.read':
    case 'test.completed':
      hooks.tool?.(event);
      break;
    case 'text.delta':
      /* Preserve messageId by emitting through control's generic typed-event
         hook (its dedicated `text` hook only carries the delta). */
      if (typeof hooks.textDelta === 'function') hooks.textDelta(event);
      else if (typeof hooks.tool === 'function') hooks.tool(event);
      else if (typeof hooks.text === 'function') hooks.text(event.delta);
      break;
    case 'file.changed':
      hooks.fileChanged?.(event);
      hooks.tool?.(event);
      break;
    case 'git.diff.updated':
      hooks.diff?.(event);
      break;
    case 'todo.updated':
      hooks.todo?.(event);
      break;
    case 'usage.updated':
      hooks.usage?.(event);
      break;
    case 'question.required':
      hooks.interaction?.(event.interactionId, 'question', { questions: event.questions });
      hooks.question?.(event);
      break;
    case 'permission.required':
      hooks.interaction?.(event.interactionId, 'permission', { permission: event.action, patterns: [event.detail].filter(Boolean) });
      hooks.permission?.(event);
      break;
    case 'interaction.closed':
      hooks.interactionClosed?.(event.interactionId);
      break;
    case 'run.state':
      hooks.state?.(event);
      break;
    case 'attention.changed':
      hooks.attention?.(event);
      break;
    default:
      break;
  }
}

export class OpenCodeRuntime {
  constructor({ dataDir, onEvent, sandbox = null }) {
    this.dataDir = dataDir;
    this.onEvent = onEvent;
    this.password = randomBytes(32).toString('hex');
    this.port = 0;
    this.sandbox = sandbox;
    this.child = null;
    this.starting = null;
    this.runs = new Map();
  }

  async start() {
    if (this.closing) throw new Error('OpenCode runtime is stopping.');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      this.startError = null;
      this.port = await freePort();
      if (this.closing) throw new Error('OpenCode runtime was cancelled before startup.');
      const discovery = path.join(this.dataDir, 'discovery');
      mkdirSync(discovery, { recursive: true, mode: 0o700 });
      const nativeState = path.join(process.env.HOME, '.local/share/opencode');
      mkdirSync(nativeState, { recursive: true, mode: 0o700 });
      const child = sandboxSpawn(process.env.WORKBENCH_OPENCODE_BIN || path.join(process.env.HOME, '.opencode/bin/opencode'),
        ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(this.port)],
        { dataDir: this.dataDir, workspace: discovery, readOnly: true, ...this.sandbox, runtimeRw: [nativeState] },
        { runtimeEnv: { OPENCODE_SERVER_USERNAME: 'workbench', OPENCODE_SERVER_PASSWORD: this.password }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.resume();
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', (error) => { this.startError = error; });
      child.on('exit', () => {
        if (this.child === child) this.child = null;
        for (const handle of this.runs.values()) {
          // During startup/teardown a map entry may be the runtime wrapper
          // rather than a live prompt controller. A child exit must never crash
          // the control plane while it is draining runs.
          if (handle?.controller && !handle.controller.signal.aborted) {
            handle.controller.abort(new Error('OpenCode runtime exited.'));
          }
        }
      });
      for (let i = 0; i < 150; i++) {
        if (this.startError) throw this.startError;
        if (child.exitCode !== null) throw new Error(`OpenCode could not start: ${stderr.slice(-500)}`);
        try { await this.request('/global/health', undefined, undefined, 1500); return; } catch { await sleep(200); }
      }
      terminateGroup(child);
      throw new Error('OpenCode startup timed out.');
    })().catch(async error => {
      /* A transient startup failure must not permanently disable the shared
         runtime: reap the partial child and reset state, but leave `closing`
         untouched so the next run can start a fresh server. */
      const child = this.child;
      this.child = null;
      this.port = 0;
      this.startError = null;
      if (child && child.exitCode === null && !child.signalCode) {
        await new Promise(resolve => { child.once('close', resolve); terminateGroup(child); });
      }
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async request(route, body, directory, timeout = 30000, method) {
    if (!this.child && !this.starting) await this.start();
    const url = new URL(route, `http://127.0.0.1:${this.port}`);
    if (directory) url.searchParams.set('directory', directory);
    const response = await fetch(url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Basic ${Buffer.from(`workbench:${this.password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const text = await response.text();
      throw fail(`OpenCode ${response.status}: ${text.slice(0, 400)}`, 502);
    }
    return response.status === 204 ? null : response.json();
  }

  async models() {
    const providers = await this.request('/provider');
    return providers.all.filter((provider) => providers.connected.includes(provider.id)).flatMap((provider) => Object.values(provider.models || {}).map((model) => ({
      id: `${provider.id}/${model.id}`,
      name: model.name || model.id,
      provider: provider.id,
      engine: 'opencode',
      contextLimit: model.limit?.context,
      outputLimit: model.limit?.output,
      images: !!model.capabilities?.input?.image,
      reasoning: !!model.capabilities?.reasoning,
      variants: Object.keys(model.variants || {}),
      cost: model.cost,
    })));
  }

  async stream(directory, controller, callback) {
    const url = new URL('/event', `http://127.0.0.1:${this.port}`);
    url.searchParams.set('directory', directory);
    const response = await fetch(url, {
      headers: { authorization: `Basic ${Buffer.from(`workbench:${this.password}`).toString('base64')}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('OpenCode event stream unavailable.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const chunk = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) {
          const event = decode(data);
          if (event) callback(event);
        }
      }
    }
  }

  async run(conversation, command, attachments, hooks) {
    // A shared writable server would let one agent execute in another agent's
    // workspace. Keep only discovery shared; each resident run owns its server.
    const runtime = new OpenCodeRuntime({ dataDir: this.dataDir, sandbox: {
      workspace: conversation.directory, readOnly: conversation.mode === 'plan',
    } });
    this.runs.set(conversation.id, { runtime });
    try { await runtime.runScoped(conversation, command, attachments, hooks); }
    finally { await runtime.close(); this.runs.delete(conversation.id); }
  }

  async runScoped(conversation, command, attachments, hooks) {
    await this.start();
    let nativeId = conversation.native_id;
    if (!nativeId) {
      const result = conversation.legacy_id
        ? await this.request(`/session/${conversation.legacy_id}/fork`, {}, conversation.directory)
        : await this.request('/session', { title: conversation.title }, conversation.directory);
      nativeId = result.id;
      hooks.binding(nativeId);
    }
    const controller = new AbortController();
    const handle = { controller, nativeId, directory: conversation.directory };
    this.runs.set(conversation.id, handle);

    /* Match OpenCode's time-sortable ID contract (pinned 1.18.x); a UUID after
       msg_ passes validation but breaks native chronological pagination. */
    const nativeMessage = command.native_message || `msg_${(BigInt(Date.now()) * 4096n + 1n).toString(16).slice(-12)}${randomBytes(7).toString('hex')}`;
    hooks.nativeMessage(nativeMessage);

    const map = new Map();
    const timers = new Map();
    const emit = (id, immediate = false) => {
      const item = map.get(id);
      if (!item?.info || item.info.role !== 'assistant') return;
      if (timers.has(id)) {
        if (!immediate) return;
        clearTimeout(timers.get(id));
      }
      const publish = () => {
        timers.delete(id);
        hooks.message({ id: item.info.id, created: item.info.time?.created || Date.now(), info: { ...item.info, role: 'assistant' }, parts: item.parts || [] });
      };
      if (immediate) publish();
      else timers.set(id, setTimeout(publish, 3000));
    };

    let idle = false;
    let sawInput = false;
    let completed = false;
    let failure = null;
    let finished = false;
    let resolveFinished;
    const finishedPromise = new Promise((resolve) => { resolveFinished = resolve; });
    const settle = () => {
      if (finished) return;
      if (idle && sawInput && (completed || failure)) {
        finished = true;
        resolveFinished();
      }
    };

    const reconcile = async () => {
      /* Native events have no durable replay guarantee. A periodic snapshot
         repairs a dropped stream and confirms completion. */
      const statuses = await this.request('/session/status', undefined, conversation.directory).catch(() => null);
      if (statuses) {
        const status = statuses[nativeId];
        if (!status || status.type === 'idle') idle = true;
      }
      const list = await this.request(`/session/${nativeId}/message?limit=100`, undefined, conversation.directory);
      const index = list.findIndex((message) => message.info?.id === nativeMessage);
      sawInput ||= index >= 0;
      for (const item of list.filter((message) => message.info.role === 'assistant' && message.info.parentID === nativeMessage)) {
        map.set(item.info.id, item);
        emit(item.info.id, true);
        if (item.info.error) failure = item.info.error.data?.message || item.info.error.name || 'Model request failed.';
        if (item.info.time?.completed && item.info.finish && !['tool-calls', 'unknown'].includes(item.info.finish)) completed = true;
      }
      for (const [kind, route] of [['permission', '/permission'], ['question', '/question']]) {
        const pending = await this.request(route, undefined, conversation.directory).catch(() => []);
        for (const interaction of (pending || []).filter((item) => item.sessionID === nativeId)) hooks.interaction(interaction.id, kind, interaction);
      }
    };

    const eventLoop = this.stream(conversation.directory, controller, (event) => {
      const properties = event.properties || {};
      if (properties.sessionID === nativeId && event.type === 'session.idle') {
        idle = true;
        settle();
        return;
      }
      if (properties.info?.sessionID === nativeId && event.type === 'message.updated') {
        idle = false;
        if (properties.info.id === nativeMessage) sawInput = true;
        const item = map.get(properties.info.id) || { parts: [] };
        item.info = properties.info;
        map.set(properties.info.id, item);
        if (properties.info.role === 'assistant' && properties.info.parentID === nativeMessage) {
          if (properties.info.error) failure = properties.info.error.data?.message || properties.info.error.name || 'Model request failed.';
          if (properties.info.time?.completed && properties.info.finish && !['tool-calls', 'unknown'].includes(properties.info.finish)) completed = true;
        }
        emit(properties.info.id, !!properties.info.time?.completed);
        settle();
      }
      if (properties.part?.sessionID === nativeId && event.type === 'message.part.updated') {
        idle = false;
        const item = map.get(properties.part.messageID) || { parts: [] };
        item.parts = item.parts.filter((part) => part.id !== properties.part.id).concat(properties.part);
        map.set(properties.part.messageID, item);
        emit(properties.part.messageID);
      }
      if (event.type === 'message.part.delta' && properties.sessionID === nativeId) {
        const item = map.get(properties.messageID);
        const part = item?.parts.find((candidate) => candidate.id === properties.partID);
        if (part && typeof properties.delta === 'string') {
          part[properties.field || 'text'] = (part[properties.field || 'text'] || '') + properties.delta;
          if ((!properties.field || properties.field === 'text') && part.type === 'text') hooks.tool?.({ kind: 'text.delta', messageId: properties.messageID, delta: properties.delta });
          emit(properties.messageID);
        }
      }
      if (properties.sessionID === nativeId && (event.type === 'permission.asked' || event.type === 'question.asked')) {
        idle = false;
        hooks.interaction(properties.id, event.type.startsWith('permission') ? 'permission' : 'question', properties);
      }
      if (properties.sessionID === nativeId && (event.type === 'permission.replied' || event.type === 'question.replied' || event.type === 'question.rejected')) {
        hooks.interactionClosed(properties.requestID || properties.id);
      }
    }).catch((error) => {
      if (!controller.signal.aborted) console.warn(JSON.stringify({ event: 'runtime_stream_disconnected', engine: 'opencode', message: error.message }));
    });

    const cancelled = new Promise((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });

    let submitted = false;
    try {
      const split = command.model.indexOf('/');
      const parts = [{ type: 'text', text: decode(command.input, {}).text || '' }];
      const saved = [];
      for (const attachment of attachments) {
        if (attachment.mime.startsWith('image/')) {
          const data = await readFile(attachment.filePath);
          parts.push({ type: 'file', mime: attachment.mime, filename: attachment.name, url: `data:${attachment.mime};base64,${data.toString('base64')}` });
        } else if (TEXT_MIME.test(String(attachment.mime || '')) && attachment.bytes <= 100_000) {
          const data = await readFile(attachment.filePath);
          parts.push({ type: 'text', text: `Attached file ${attachment.name}:\n${data.toString('utf8')}` });
        } else {
          saved.push(`- ${attachment.name} (${attachment.mime}, ${attachment.bytes} bytes) is saved at ${attachment.filePath}`);
        }
      }
      if (saved.length) parts.push({ type: 'text', text: `Attached files are on disk — read/process them with your tools:\n${saved.join('\n')}` });
      hooks.running();
      try {
        await this.request(`/session/${nativeId}/prompt_async`, {
          messageID: nativeMessage,
          model: { providerID: command.model.slice(0, split), modelID: command.model.slice(split + 1) },
          agent: conversation.mode === 'plan' ? 'plan' : 'build',
          ...(command.reasoning ? { variant: command.reasoning } : {}),
          parts,
        }, conversation.directory);
        submitted = true;
        /* The prompt was accepted, so the input turn exists even if the newest
           page snapshot no longer contains it (long sessions). */
        sawInput = true;
      } catch (error) {
        error.uncertain = true;
        throw error;
      }
      const deadline = Date.now() + 2 * 60 * 60 * 1000;
      while (!finished && !controller.signal.aborted) {
        if (Date.now() > deadline) throw new Error('Run exceeded its two-hour time budget.');
        const outcome = await Promise.race([
          finishedPromise.then(() => 'finished'),
          cancelled.then(() => 'cancelled'),
          sleep(5000).then(() => 'poll'),
        ]);
        if (outcome !== 'poll') break;
        await reconcile();
        settle();
      }
      if (controller.signal.aborted) throw Object.assign(new Error('Run cancelled.'), { cancelled: true, uncertain: true });
      if (failure) throw new Error(failure);
    } catch (error) {
      if (submitted) await this.request(`/session/${nativeId}/abort`, {}, conversation.directory).catch(() => {});
      throw error;
    } finally {
      controller.abort();
      await eventLoop;
      for (const timer of timers.values()) clearTimeout(timer);
      for (const id of map.keys()) emit(id, true);
      this.runs.delete(conversation.id);
    }
  }

  async stop(conversationId) {
    const handle = this.runs.get(conversationId);
    if (!handle) return;
    if (handle.runtime) { await handle.runtime.stop(conversationId); await handle.runtime.close(); return; }
    await this.request(`/session/${handle.nativeId}/abort`, {}, handle.directory).catch(() => {});
    handle.controller.abort('cancelled');
  }

  async respond(conversation, interaction, body) {
    const runtime = this.runs.get(conversation.id)?.runtime;
    if (runtime) return runtime.respond(conversation, interaction, body);
    const directory = this.runs.get(conversation.id)?.directory || conversation.directory;
    const route = interaction.kind === 'permission' ? `/permission/${interaction.id}/reply` : `/question/${interaction.id}/${body.reject ? 'reject' : 'reply'}`;
    return this.request(route, interaction.kind === 'permission' ? { reply: body.reply } : body.reject ? {} : { answers: body.answers }, directory);
  }

  async close() {
    this.closing = true;
    for (const handle of this.runs.values()) {
      if (handle.runtime) await handle.runtime.close();
      else handle.controller.abort('shutdown');
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode) return;
    // Bound the wait: a child that ignores TERM, or that exits between the check
    // above and the listener attach, must never hang the caller (POST /stop).
    await new Promise(resolve => {
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      child.once('close', done); child.once('exit', done);
      const timer = setTimeout(done, 4000); timer.unref?.();
      terminateGroup(child);
    });
  }
}

export class PiRuntime {
  constructor({ dataDir, syncSharedOAuthCredential = async () => { throw new Error('Shared OAuth synchronization is unavailable.'); } }) {
    this.dataDir = dataDir;
    this.runs = new Map();
    this.openAICatalog = [];
    this.syncSharedOAuthCredential = syncSharedOAuthCredential;
    this.oauthSyncQueue = Promise.resolve();
  }

  setOpenAICatalog(models) {
    this.openAICatalog = Array.isArray(models) ? models.filter((model) => model.provider === 'openai') : [];
  }

  handleSharedOAuthMessage(child, message) {
    if (message.type !== 'sync-shared-oauth') return false;
    const sync = () => this.syncSharedOAuthCredential({ provider: message.provider, credential: message.credential });
    const task = this.oauthSyncQueue.then(sync, sync);
    this.oauthSyncQueue = task.catch(() => {});
    void task.then(
      () => { if (child.connected) child.send({ type: 'sync-shared-oauth-result', id: message.id }); },
      (error) => { if (child.connected) child.send({ type: 'sync-shared-oauth-result', id: message.id, error: error.message }); },
    );
    return true;
  }

  spawn(sandbox = null) {
    const file = fileURLToPath(new URL('./pi-runner.mjs', import.meta.url));
    const agentDir = path.join(this.dataDir, 'pi');
    const discovery = path.join(this.dataDir, 'discovery');
    for (const dir of [agentDir, discovery]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return sandboxSpawn(process.execPath, ['--max-old-space-size=512', file], {
      workspace: discovery, readOnly: true, ...sandbox, dataDir: this.dataDir, runtimeRw: [agentDir],
    }, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  }

  async models(openAICatalog) {
    if (openAICatalog !== undefined) this.setOpenAICatalog(openAICatalog);
    const child = this.spawn();
    child.stderr.resume();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => { terminateGroup(child); finish(new Error('Pi model discovery timed out.')); }, 60000);
      timer.unref();
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => finish(new Error(`Pi model discovery exited (${signal || code}).`)));
      child.on('message', (event) => {
        if (this.handleSharedOAuthMessage(child, event)) return;
        if (event.type === 'models') finish(null, event.models);
      });
      child.send({ type: 'models', dataDir: this.dataDir, openAICatalog: this.openAICatalog });
    });
  }

  async run(conversation, command, attachments, hooks) {
    const workspace = conversation.directory;
    const child = this.spawn({ workspace, readOnly: conversation.mode === 'plan' });
    this.runs.set(conversation.id, child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    return new Promise((resolve, reject) => {
      let settled = false;
      let resultError;
      let reportedDone = false;
      const timer = setTimeout(() => { resultError = new Error('Pi run exceeded its two-hour time budget.'); terminateGroup(child); }, 2 * 60 * 60 * 1000);
      timer.unref();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.runs.delete(conversation.id);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => {
        signalGroup(child, 'SIGKILL');
        finish(resultError || (reportedDone && code === 0 && !signal ? null : new Error(`Pi runner exited (${signal || code}): ${stderr.slice(-500)}`)));
      });
      child.on('message', (event) => {
        try {
        if (this.handleSharedOAuthMessage(child, event)) return;
        if (event.type === 'binding') hooks.binding(event.nativeId);
        else if (event.type === 'message') hooks.message(event.message);
        else if (event.type === 'activity') hooks.activity?.(event.activity);
        else if (event.type === 'event') dispatchPiEvent(event.event, hooks);
        else if (event.type === 'done') {
          reportedDone = true;
          resultError = event.error ? new Error(event.error) : null;
          // The runner normally exits immediately after sending done.
          const reap = setTimeout(() => terminateGroup(child), 1000);
          reap.unref();
          child.once('close', () => clearTimeout(reap));
        }
        } catch (error) { resultError = error; terminateGroup(child); }
      });
      try { hooks.running(); } catch (error) { resultError = error; terminateGroup(child); return; }
      child.send({
        type: 'run',
        commandId: command.id,
        directory: conversation.directory,
        nativeId: Number(command.attempts) > 0 ? null : conversation.native_id,
        model: command.model,
        reasoning: command.reasoning,
        mode: conversation.mode,
        permission: command.permission,
        text: decode(command.input, {}).text,
        attachments,
        dataDir: this.dataDir,
        openAICatalog: this.openAICatalog,
      });
    });
  }

  async respond(conversation, interaction, body) {
    const child = this.runs.get(conversation.id);
    if (!child || !child.connected) return;
    child.send({ type: 'response', interactionId: interaction.id, reply: body.reply, answers: body.answers, reject: !!body.reject });
  }

  /* Codex-style steer: inject a user message into the running agent so the
     current Run adapts at its next step. Returns false when no worker owns
     this conversation (the caller then falls back to the durable queue). */
  async steer(conversationId, text) {
    const child = this.runs.get(conversationId);
    if (!child || !child.connected) return false;
    child.send({ type: 'steer', text: String(text || '') });
    return true;
  }

  async stop(conversationId) {
    const child = this.runs.get(conversationId);
    if (!child) return;
    try { child.send({ type: 'stop' }); } catch {}
    const timer = setTimeout(() => terminateGroup(child), 5000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }

  close() {
    for (const child of this.runs.values()) {
      terminateGroup(child);
    }
  }
}
