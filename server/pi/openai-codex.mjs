export const OPENAI_CODEX_PROVIDER = 'openai-codex';
export const OPENAI_CODEX_API = 'openai-codex-responses';
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

/* OpenCode stores ChatGPT OAuth under `openai`; Pi's native subscription
   adapter is `openai-codex`. Keep the source credential shape intact so Pi's
   own OAuth refresh logic can manage the token. */
export function sharedOpenAICodexCredential(openCodeAuth, piAuth) {
  const credential = openCodeAuth?.openai;
  if (credential?.type !== 'oauth' || piAuth?.[OPENAI_CODEX_PROVIDER]) return null;

  const { access, refresh, expires, accountId } = credential;
  if (typeof access !== 'string' || typeof refresh !== 'string' || !Number.isFinite(expires)) return null;
  return {
    type: 'oauth',
    access,
    refresh,
    expires,
    ...(typeof accountId === 'string' ? { accountId } : {}),
  };
}

function modelId(model) {
  const prefix = `${model.provider}/`;
  if (typeof model.id !== 'string') return null;
  return model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
}

function numeric(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nativeDefinition(model) {
  const definition = {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: !!model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input || ['text'],
    inputLimits: model.inputLimits,
    cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    promptCache: model.promptCache,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    samplingParams: model.samplingParams,
    compat: model.compat,
  };
  return Object.fromEntries(Object.entries(definition).filter(([, value]) => value !== undefined));
}

/* Reuse the full OpenCode OAuth catalog in Pi, but send it through Pi's native
   ChatGPT/Codex Responses adapter. Native Pi model definitions are retained for
   fields OpenCode's catalog does not expose (thinking levels and compat). */
export function openAICodexModelDefinitions(openCodeModels, nativeModels = []) {
  const definitions = new Map(nativeModels.map((model) => [model.id, nativeDefinition(model)]));

  for (const model of openCodeModels || []) {
    if (model.provider !== 'openai') continue;
    const id = modelId(model);
    if (!id) continue;
    const base = definitions.get(id);
    const sourceCost = model.cost || {};
    const cache = sourceCost.cache || {};
    definitions.set(id, {
      ...base,
      id,
      name: model.name || base?.name || id,
      api: OPENAI_CODEX_API,
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: model.reasoning ?? base?.reasoning ?? false,
      input: model.images ? ['text', 'image'] : (base?.input || ['text']),
      cost: {
        input: numeric(sourceCost.input, base?.cost?.input),
        output: numeric(sourceCost.output, base?.cost?.output),
        cacheRead: numeric(cache.read ?? sourceCost.cacheRead, base?.cost?.cacheRead),
        cacheWrite: numeric(cache.write ?? sourceCost.cacheWrite, base?.cost?.cacheWrite),
      },
      contextWindow: numeric(model.contextLimit, base?.contextWindow || 128000),
      maxTokens: numeric(model.outputLimit, base?.maxTokens || 16384),
    });
  }

  return [...definitions.values()];
}
