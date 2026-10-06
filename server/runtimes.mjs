import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, fail } from './store.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_')));

export const CAPABILITIES = {
  opencode: { images: true, files: true, questions: true, permissions: true, usage: true, fork: true, modes: true, plan: true },
  pi: { images: true, files: true, questions: false, permissions: false, usage: true, fork: true, modes: true, plan: true },
};

export class OpenCodeRuntime {
  constructor({ dataDir, onEvent }) {
    this.dataDir = dataDir;
    this.onEvent = onEvent;
    this.password = randomBytes(32).toString('hex');
    this.port = Number(process.env.WORKBENCH_OPENCODE_PORT || 4198);
    this.child = null;
    this.starting = null;
    this.runs = new Map();
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      this.startError = null;
      const child = spawn(process.env.WORKBENCH_OPENCODE_BIN || path.join(process.env.HOME, '.opencode/bin/opencode'),
        ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(this.port)],
        { cwd: this.dataDir, env: { ...cleanEnv(), OPENCODE_SERVER_USERNAME: 'workbench', OPENCODE_SERVER_PASSWORD: this.password }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      child.stdout.resume();
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.on('error', (error) => { this.startError = error; });
      child.on('exit', () => {
        if (this.child === child) this.child = null;
        for (const handle of this.runs.values()) handle.controller.abort(new Error('OpenCode runtime exited.'));
      });
      for (let i = 0; i < 150; i++) {
        if (this.startError) throw this.startError;
        if (child.exitCode !== null) throw new Error(`OpenCode could not start: ${stderr.slice(-500)}`);
        try { await this.request('/global/health', undefined, undefined, 1500); return; } catch { await sleep(200); }
      }
      child.kill();
      throw new Error('OpenCode startup timed out.');
    })().finally(() => { this.starting = null; });
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
      else timers.set(id, setTimeout(publish, 80));
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
        emit(properties.info.id);
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
      for (const attachment of attachments) {
        const data = await readFile(attachment.filePath);
        if (attachment.mime.startsWith('image/')) parts.push({ type: 'file', mime: attachment.mime, filename: attachment.name, url: `data:${attachment.mime};base64,${data.toString('base64')}` });
        else parts.push({ type: 'text', text: `Attached file ${attachment.name}:\n${data.toString('utf8')}` });
      }
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
    await this.request(`/session/${handle.nativeId}/abort`, {}, handle.directory).catch(() => {});
    handle.controller.abort('cancelled');
  }

  async respond(conversation, interaction, body) {
    const route = interaction.kind === 'permission' ? `/permission/${interaction.id}/reply` : `/question/${interaction.id}/${body.reject ? 'reject' : 'reply'}`;
    return this.request(route, interaction.kind === 'permission' ? { reply: body.reply } : body.reject ? {} : { answers: body.answers }, conversation.directory);
  }

  close() {
    for (const handle of this.runs.values()) handle.controller.abort('shutdown');
    this.child?.kill('SIGTERM');
  }
}

export class PiRuntime {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.runs = new Map();
  }

  spawn() {
    return fork(fileURLToPath(new URL('./pi-runner.mjs', import.meta.url)), [], {
      env: cleanEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: true,
    });
  }

  async models() {
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
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} finish(new Error('Pi model discovery timed out.')); }, 60000);
      timer.unref();
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => finish(new Error(`Pi model discovery exited (${signal || code}).`)));
      child.on('message', (event) => {
        if (event.type === 'models') finish(null, event.models);
      });
      child.send({ type: 'models', dataDir: this.dataDir });
    });
  }

  async run(conversation, command, attachments, hooks) {
    const child = this.spawn();
    this.runs.set(conversation.id, child);
    child.stderr.resume();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} finish(new Error('Pi run exceeded its two-hour time budget.')); }, 2 * 60 * 60 * 1000);
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
      child.once('exit', (code, signal) => finish(new Error(`Pi runner exited (${signal || code}).`)));
      child.on('message', (event) => {
        if (event.type === 'binding') hooks.binding(event.nativeId);
        else if (event.type === 'message') hooks.message(event.message);
        else if (event.type === 'done') finish(event.error ? new Error(event.error) : null);
      });
      hooks.running();
      child.send({
        type: 'run',
        commandId: command.id,
        directory: conversation.directory,
        nativeId: conversation.native_id,
        model: command.model,
        reasoning: command.reasoning,
        mode: conversation.mode,
        text: decode(command.input, {}).text,
        attachments,
        dataDir: this.dataDir,
      });
    });
  }

  async stop(conversationId) {
    const child = this.runs.get(conversationId);
    if (!child) return;
    try { child.send({ type: 'stop' }); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 5000);
    timer.unref();
  }

  close() {
    for (const child of this.runs.values()) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
  }
}
