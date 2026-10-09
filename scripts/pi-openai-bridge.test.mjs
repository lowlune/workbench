import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENAI_CODEX_API,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_PROVIDER,
  openAICodexModelDefinitions,
  sharedOpenAICodexCredential,
} from '../server/pi/openai-codex.mjs';

test('OpenCode OpenAI OAuth is mapped to Pi Codex OAuth without replacing a Pi-owned login', () => {
  const credential = { type: 'oauth', access: 'access', refresh: 'refresh', expires: 1234, accountId: 'account' };
  assert.deepEqual(sharedOpenAICodexCredential({ openai: credential }, {}), credential);
  assert.equal(sharedOpenAICodexCredential({ openai: credential }, { [OPENAI_CODEX_PROVIDER]: credential }), null);
  assert.equal(sharedOpenAICodexCredential({ openai: { type: 'api', key: 'api-key' } }, {}), null);
});

test('OpenCode OpenAI offerings become Pi Codex models while native compatibility metadata is retained', () => {
  const native = {
    id: 'gpt-5.4', name: 'Native GPT 5.4', api: OPENAI_CODEX_API,
    baseUrl: OPENAI_CODEX_BASE_URL, reasoning: true, input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 32000, compat: { supportsOpenAIGrammarTools: true },
  };
  const result = openAICodexModelDefinitions([
    { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'openai', contextLimit: 1050000, outputLimit: 128000, images: true, reasoning: true, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
    { id: 'opencode-go/model', name: 'Other model', provider: 'opencode-go' },
  ], [native]);

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    ...native,
    name: 'GPT-5.4',
    baseUrl: OPENAI_CODEX_BASE_URL,
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
});
