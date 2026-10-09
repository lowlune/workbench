import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';
import {
  OPENAI_CODEX_PROVIDER,
  openAICodexModelDefinitions,
  sharedOpenAICodexCredential,
} from './pi/openai-codex.mjs';
import { createWorkbenchExtension, BUILD_TOOLS, READ_ONLY_TOOLS } from './pi/tools.mjs';
import { workbenchAgentsFile, createAgentsFilesOverride } from './pi/context.mjs';
import { classifyTool, summarizeTool, usageEvent, toolTitle, commandArg, writeChange, capDiff, textOfMessage, diffText, currentAction, estimateEta, parseDeletedPaths } from './pi/events.mjs';

const send = (value) => { if (process.connected) process.send(value); };
const emit = (event) => send({ type: 'event', event });

/* Small text-ish attachments are inlined into the prompt; anything else (PDF,
   ZIP, binaries, …) is left on disk and the agent is told the path so it can
   read/process it with its own tools. */
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|x-sh|x-ndjson|toml|sql|graphql|x-httpd-php))/;
const isTextLike = (mime) => TEXT_MIME.test(String(mime || ''));

function sendAndExit(value, code) {
  const leave = () => { try { process.disconnect(); } catch {} process.exit(code); };
  if (process.connected) process.send(value, leave);
  else leave();
}

let session;
let active = null;
let counter = 0;
let settleResolve = null;
let lastError = null;
let oauthSyncSequence = 0;
const oauthSyncWaiters = new Map();

function compactInput(args) {
  if (!args || typeof args !== 'object') return undefined;
  const out = {};
  for (const key of ['path', 'command', 'pattern', 'action', 'query', 'timeout']) if (key in args) out[key] = args[key];
  return Object.keys(out).length ? out : undefined;
}

function permissionMode(value) {
  return ['off', 'dangerous', 'all'].includes(value) ? value : (['off','dangerous','all'].includes(process.env.WORKBENCH_PERMISSION) ? process.env.WORKBENCH_PERMISSION : 'off');
}

function requestQuestion(questions) {
  const interactionId = `question_${active.commandId}_${randomBytes(6).toString('hex')}`;
  return new Promise((resolve, reject) => {
    active.pending.set(interactionId, { kind: 'question', resolve, reject });
    emit({ kind: 'run.state', status: 'waiting_for_user' });
    emit({ kind: 'question.required', interactionId, questions });
    emit({ kind: 'attention.changed', attention: 'waiting' });
  });
}

function requestPermission({ action, detail, toolCallId }) {
  const interactionId = `permission_${active.commandId}_${randomBytes(6).toString('hex')}`;
  return new Promise((resolve, reject) => {
    active.pending.set(interactionId, { kind: 'permission', resolve, reject });
    emit({ kind: 'run.state', status: 'waiting_for_permission' });
    emit({ kind: 'permission.required', interactionId, action, detail, toolCallId });
    emit({ kind: 'attention.changed', attention: 'permission' });
  });
}

function closeInteraction(interactionId, status) {
  emit({ kind: 'interaction.closed', interactionId, status });
  emit({ kind: 'attention.changed', attention: 'none' });
  emit({ kind: 'run.state', status: 'running' });
}

async function abortRun() {
  if (!active) { await session?.abort().catch(() => {}); return; }
  active.aborted = true;
  for (const pending of active.pending.values()) pending.reject(new Error('Run cancelled.'));
  active.pending.clear();
  emit({ kind: 'run.state', status: 'interrupting' });
  try { await session?.abort(); } catch {}
}

async function createWorkbenchModelRuntime(agentDir, openAICatalog = []) {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const persistentAuthPath = path.join(agentDir, 'auth.json');
  const piAuth = JSON.parse(await readFile(persistentAuthPath, 'utf8').catch(() => '{}'));
  const openCodeAuth = JSON.parse(await readFile(path.join(process.env.HOME, '.local/share/opencode/auth.json'), 'utf8').catch(() => '{}'));
  const sharedCredential = sharedOpenAICodexCredential(openCodeAuth, piAuth);
  const runtimeAuth = { ...piAuth };
  if (sharedCredential) runtimeAuth[OPENAI_CODEX_PROVIDER] = sharedCredential;

  /* OAuth credentials are copied into a per-run file so Pi's refresh can be
     synchronized back to OpenCode without persisting a second stale copy. */
  const authPath = path.join(agentDir, `.workbench-auth-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  await writeFile(authPath, JSON.stringify(runtimeAuth), { mode: 0o600 });
  try {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: path.join(agentDir, 'models-cache.json'), allowModelNetwork: false });
    for (const [provider, value] of Object.entries(openCodeAuth)) if (value.type === 'api' && value.key && runtime.getProvider(provider) && !runtime.hasConfiguredAuth(provider)) await runtime.setRuntimeApiKey(provider, value.key);
    if (sharedCredential) {
      const definitions = openAICodexModelDefinitions(openAICatalog, runtime.getModels(OPENAI_CODEX_PROVIDER));
      if (definitions.length) runtime.registerProvider(OPENAI_CODEX_PROVIDER, { models: definitions });
    }
    return { runtime, authPath, sharedCredential };
  } catch (error) {
    await unlink(authPath).catch(() => {});
    throw error;
  }
}

async function releaseWorkbenchModelRuntime(context) {
  try {
    if (!context.sharedCredential) return;
    const runtimeAuth = JSON.parse(await readFile(context.authPath, 'utf8').catch(() => '{}'));
    const current = runtimeAuth[OPENAI_CODEX_PROVIDER];
    if (current?.type !== 'oauth') return;
    if (current.access === context.sharedCredential.access
      && current.refresh === context.sharedCredential.refresh
      && current.expires === context.sharedCredential.expires) return;
    await requestSharedOAuthSync({ provider: 'openai', credential: current });
  } finally {
    await unlink(context.authPath).catch(() => {});
  }
}

function requestSharedOAuthSync({ provider, credential }) {
  if (!process.connected) return Promise.reject(new Error('Workbench control plane disconnected before OAuth credentials could be synchronized.'));
  const id = `oauth_${process.pid}_${++oauthSyncSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      oauthSyncWaiters.delete(id);
      reject(new Error('Timed out synchronizing shared OpenAI credentials.'));
    }, 30000);
    timer.unref?.();
    oauthSyncWaiters.set(id, { resolve, reject, timer });
    process.send({ type: 'sync-shared-oauth', id, provider, credential }, (error) => {
      if (!error) return;
      clearTimeout(timer);
      oauthSyncWaiters.delete(id);
      reject(error);
    });
  });
}

async function modelsOnce(message) {
  const agentDir = path.join(message.dataDir, 'pi');
  const context = await createWorkbenchModelRuntime(agentDir, message.openAICatalog || []);
  let result;
  try {
    const models = await context.runtime.getAvailable();
    result = { type: 'models', models: models.map((m) => ({ id: `${m.provider}/${m.id}`, provider: m.provider, name: m.name, contextLimit: m.contextWindow, outputLimit: m.maxTokens, images: m.input?.includes('image'), reasoning: m.reasoning, engine: 'pi', cost: m.cost })) };
  } finally {
    await releaseWorkbenchModelRuntime(context);
  }
  sendAndExit(result, 0);
}

async function runOnce(message) {
  const agentDir = path.join(message.dataDir, 'pi');
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const state = { todos: [], allowedTools: new Set(), permissionMode: permissionMode(message.permission), startedAt: Date.now() };
  active = { commandId: message.commandId, state, pending: new Map(), preImages: new Map(), aborted: false };
  lastError = null;
  counter = 0;

  const modelRuntimeContext = await createWorkbenchModelRuntime(agentDir, message.openAICatalog || []);
  active.modelRuntimeContext = modelRuntimeContext;
  const runtime = modelRuntimeContext.runtime;
  const models = await runtime.getAvailable();
  const split = message.model.indexOf('/');
  const model = runtime.getModel(message.model.slice(0, split), message.model.slice(split + 1));
  if (!model || !models.some((m) => m.id === model.id && m.provider === model.provider)) throw new Error('This model is not authenticated in Pi. Connect its provider in Usage & models.');

  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: { mode: 'off' } });
  const port = {
    cwd: message.directory,
    state,
    preImages: active.preImages,
    emit,
    requestQuestion,
    requestPermission,
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: message.directory,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
    extensionFactories: [createWorkbenchExtension(port)],
    agentsFilesOverride: createAgentsFilesOverride({ globalFile: workbenchAgentsFile() }),
    appendSystemPrompt: ['You are running inside Workbench. Complete the user task using the available tools. Keep progress updates concise. Preserve existing user changes. Do not commit or deploy unless requested.'],
  });
  await resourceLoader.reload();

  const manager = message.nativeId ? SessionManager.open(message.nativeId) : SessionManager.create(message.directory, path.join(agentDir, 'sessions'));
  ({ session } = await createAgentSession({
    cwd: message.directory,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: message.reasoning || 'off',
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    tools: message.mode === 'plan' ? READ_ONLY_TOOLS : BUILD_TOOLS,
  }));
  send({ type: 'binding', nativeId: session.sessionFile });

  const messages = new Map();
  const timers = new Map();
  const toolCalls = new Map();
  let current;
  const settled = new Promise((resolve) => { settleResolve = resolve; });

  function publish(message, immediate = false) {
    if (timers.has(message.id)) { if (!immediate) return; clearTimeout(timers.get(message.id)); timers.delete(message.id); }
    const dispatch = () => { timers.delete(message.id); send({ type: 'message', message }); };
    if (immediate) dispatch(); else timers.set(message.id, setTimeout(dispatch, 3000));
  }
  function content(message) {
    return (message.content || []).flatMap((part, index) => part.type === 'text'
      ? [{ id: `${current.id}_${index}`, type: 'text', text: part.text }]
      : part.type === 'toolCall'
        ? [{ id: part.id, type: 'tool', tool: part.name, callID: part.id, state: { status: 'pending', input: part.arguments, title: part.name } }]
        : []);
  }
  function patchToolPart(toolCallId, status, output, error) {
    for (const message of messages.values()) {
      const part = message.parts.find((candidate) => candidate.callID === toolCallId);
      if (!part) continue;
      part.state = { ...part.state, status, ...(output ? { output } : {}), ...(error ? { error } : {}) };
      publish(message, true);
    }
  }
  const runProgress = () => estimateEta(state.todos, state.startedAt);

  session.subscribe((event) => {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      current = { id: `pi_${message.commandId}_${++counter}`, created: Date.now(), lastText: '', info: { role: 'assistant', providerID: model.provider, modelID: model.id, modelName: model.name, contextLimit: model.contextWindow }, parts: [], extra: [] };
      messages.set(current.id, current);
      publish(current, true);
    }
    if (event.type === 'message_update' && current) {
      /* Pi only exposes the accumulated assistant message, so derive the
         increment ourselves and stream just that as `text.delta`; the
         throttled full snapshot still flows via the `message` hook. */
      const nextText = textOfMessage(event.message);
      const { delta, resync } = diffText(current.lastText || '', nextText);
      if (delta) emit({ kind: 'text.delta', messageId: current.id, delta });
      current.lastText = nextText;
      current.parts = [...content(event.message), ...(current.extra || [])];
      publish(current, resync);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && current) {
      current.lastText = textOfMessage(event.message);
      current.parts = [...content(event.message), ...(current.extra || [])];
      const usage = event.message.usage;
      if (usage) {
        current.info = { ...current.info, tokens: { input: usage.input, output: usage.output, cache: { read: usage.cacheRead, write: usage.cacheWrite } }, cost: usage.cost?.total };
        const usagePayload = usageEvent(usage, { runId: message.commandId, messageId: current.id });
        if (usagePayload) emit(usagePayload);
      }
      if (event.message.stopReason === 'error') lastError = event.message.errorMessage || 'Pi model request failed.';
      publish(current, true);
    }
    if (event.type === 'tool_execution_start') {
      const args = event.args || {};
      toolCalls.set(event.toolCallId, { toolName: event.toolName, args });
      emit({ kind: 'tool.started', toolCallId: event.toolCallId, tool: event.toolName, toolKind: classifyTool(event.toolName), title: toolTitle(event.toolName, args), input: compactInput(args), currentAction: currentAction(event.toolName, args), ...runProgress() });
      if (event.toolName === 'bash') emit({ kind: 'command.started', toolCallId: event.toolCallId, command: commandArg(args) || '' });
    }
    if (event.type === 'tool_execution_update') {
      const record = toolCalls.get(event.toolCallId);
      if (record) emit({ kind: 'tool.progress', toolCallId: event.toolCallId, tool: record.toolName, toolKind: classifyTool(record.toolName), title: toolTitle(record.toolName, record.args), currentAction: currentAction(record.toolName, record.args), ...runProgress() });
    }
    if (event.type === 'tool_execution_end') {
      const record = toolCalls.get(event.toolCallId) || { toolName: event.toolName, args: {} };
      toolCalls.delete(event.toolCallId);
      const preImage = active?.preImages.get(event.toolCallId);
      active?.preImages.delete(event.toolCallId);
      const info = summarizeTool({ toolName: record.toolName, args: record.args, result: event.result, isError: event.isError, preImage });
      emit({ kind: 'tool.completed', toolCallId: event.toolCallId, tool: record.toolName, title: toolTitle(record.toolName, record.args), currentAction: currentAction(record.toolName, record.args), ...info, ...runProgress() });
      if (record.toolName === 'read' && info.path) emit({ kind: 'file.read', toolCallId: event.toolCallId, path: info.path });
      if ((record.toolName === 'edit' || record.toolName === 'write') && info.path) {
        const change = record.toolName === 'edit'
          ? { change: 'modified', additions: info.additions || 0, deletions: info.deletions || 0, diff: event.result?.details?.patch || event.result?.details?.diff || info.diff }
          : writeChange(info.path, preImage, typeof record.args.content === 'string' ? record.args.content : '');
        emit({ kind: 'file.changed', toolCallId: event.toolCallId, path: info.path, ...change, diff: capDiff(change.diff) });
      }
      const deletedPaths = record.toolName === 'bash' && !event.isError ? parseDeletedPaths(commandArg(record.args) || '') : [];
      for (const deletedPath of deletedPaths) emit({ kind: 'file.changed', toolCallId: event.toolCallId, path: deletedPath, change: 'deleted', additions: 0, deletions: 0 });
      if (record.toolName === 'bash') emit({ kind: 'command.completed', toolCallId: event.toolCallId, command: commandArg(record.args) || '', exitCode: info.exitCode, summary: info.summary, deleted: deletedPaths.length ? deletedPaths : undefined });
      const output = event.result?.content ? textFrom(event.result) : undefined;
      patchToolPart(event.toolCallId, event.isError ? 'error' : 'completed', output, event.isError ? output : undefined);
      /* Keep images a tool produced (e.g. `read` on a screenshot) in the turn
         as `file` parts so the transcript can render them inline. */
      if (current && event.result) {
        const images = imagePartsFrom(event.result, current.id, event.toolCallId);
        if (images.length) {
          current.extra = [...(current.extra || []), ...images];
          current.parts = [...current.parts, ...images];
          publish(current, true);
        }
      }
    }
    if (event.type === 'auto_retry_start' || event.type === 'compaction_start') send({ type: 'activity', activity: event.type });
    if (event.type === 'agent_settled') settleResolve?.();
  });

  const images = [];
  const saved = [];
  let text = message.text;
  for (const attachment of message.attachments || []) {
    if (attachment.mime.startsWith('image/')) {
      const bytes = await readFile(attachment.filePath);
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: attachment.mime });
    } else if (isTextLike(attachment.mime) && attachment.bytes <= 100_000) {
      const bytes = await readFile(attachment.filePath);
      text += `\n\nAttached file (${attachment.name}):\n${bytes.toString('utf8').slice(0, 100_000)}`;
    } else {
      saved.push(`- ${attachment.name} (${attachment.mime}, ${attachment.bytes} bytes) is saved at ${attachment.filePath}`);
    }
  }
  if (saved.length) text += `\n\nAttached files are on disk — read/process them with your tools:\n${saved.join('\n')}`;

  emit({ kind: 'run.state', status: 'running', model: `${model.provider}/${model.id}`, provider: model.provider });
  try {
    await session.prompt(text, { images, expandPromptTemplates: false });
    await Promise.race([settled, session.waitForIdle()]);
  } catch (error) {
    if (!active?.aborted) lastError = error.message;
  } finally {
    for (const timer of timers.values()) clearTimeout(timer);
    for (const current of messages.values()) publish(current, true);
    try { await releaseWorkbenchModelRuntime(modelRuntimeContext); }
    catch (error) { lastError ||= `Shared OpenAI credential synchronization failed: ${error.message}`; }
    try {
      const stats = session.getSessionStats();
      emit({ kind: 'usage.updated', total: true, runId: message.commandId, input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, totalTokens: stats.tokens.total, cost: stats.cost });
    } catch {}
    session.dispose();
    session = undefined;
    if (active) {
      const aborted = active.aborted;
      active = null;
      const status = aborted ? 'cancelled' : lastError ? 'failed' : 'completed';
      emit({ kind: 'run.state', status, error: lastError || undefined });
      sendAndExit({ type: 'done', error: lastError || null }, lastError ? 1 : 0);
    }
  }
}

function textFrom(result) {
  return (result.content || []).filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

/* Image content a tool result carried (Pi returns `{ type: 'image', data,
   mimeType }`). Turned into `file` message parts for inline rendering. */
function imagePartsFrom(result, messageId, toolCallId) {
  return (result?.content || []).flatMap((part, index) => {
    if (!part || part.type !== 'image' || !part.data) return [];
    const mime = part.mimeType || part.mime || 'image/png';
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png';
    return [{
      id: `${messageId}_img_${toolCallId}_${index}`,
      type: 'file',
      mime,
      filename: part.filename || `${toolCallId}-${index}.${ext}`,
      url: `data:${mime};base64,${part.data}`,
    }];
  });
}

process.on('message', async (message) => {
  try {
    if (message.type === 'sync-shared-oauth-result') {
      const waiter = oauthSyncWaiters.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      oauthSyncWaiters.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve();
      return;
    }
    if (message.type === 'stop') { await abortRun(); return; }
    if (message.type === 'steer') {
      const text = String(message.text || '');
      if (session && typeof session.steer === 'function' && text) {
        await session.steer(text);
        emit({ kind: 'steer.delivered', text });
      }
      return;
    }
    if (message.type === 'response') {
      const pending = active?.pending.get(message.interactionId);
      if (!pending) return;
      active.pending.delete(message.interactionId);
      if (pending.kind === 'question') pending.resolve(message.reject ? null : (Array.isArray(message.answers) ? message.answers : []));
      else pending.resolve(typeof message.reply === 'string' ? message.reply : 'reject');
      closeInteraction(message.interactionId, 'answered');
      return;
    }
    if (message.type === 'models') { await modelsOnce(message); return; }
    if (message.type !== 'run') return;
    await runOnce(message);
  } catch (error) {
    if (active?.modelRuntimeContext) {
      const context = active.modelRuntimeContext;
      active.modelRuntimeContext = null;
      try { await releaseWorkbenchModelRuntime(context); }
      catch (syncError) { error.message = `${error.message}; shared OpenAI credential synchronization failed: ${syncError.message}`; }
    }
    for (const pending of active?.pending.values() || []) pending.reject(error);
    const hadRun = !!active;
    if (active) active.pending.clear();
    session?.dispose();
    session = undefined;
    if (hadRun) {
      active = null;
      emit({ kind: 'run.state', status: 'failed', error: error.message });
      sendAndExit({ type: 'done', error: error.message }, 1);
    } else if (message.type === 'models') {
      active = null;
      process.disconnect();
    }
  }
});
process.on('disconnect', () => { session?.dispose(); process.exit(0); });
