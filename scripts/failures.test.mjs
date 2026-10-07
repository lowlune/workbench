import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, describeFailure, retryDelay, RETRYABLE_CODES } from '../server/failures.mjs';

test('classifies the real provider/transport errors that used to be terminal', () => {
  // The exact strings observed in production logs.
  assert.equal(classifyFailure('Connection error.'), 'network_error');
  assert.equal(classifyFailure('AI_APICallError: Cannot connect to API: Was there a typo in the url or port?'), 'network_error');
  assert.equal(classifyFailure('AI_APICallError: The usage limit has been reached'), 'provider_rate_limit');
  assert.equal(classifyFailure('503 Service Unavailable'), 'provider_unavailable');
  assert.equal(classifyFailure('429 too many requests'), 'provider_rate_limit');
  assert.equal(classifyFailure('401 Unauthorized: invalid api key'), 'provider_auth');
});

test('transient codes are retryable; auth/context/model are not', () => {
  for (const code of ['network_error', 'provider_unavailable', 'provider_rate_limit']) assert.ok(RETRYABLE_CODES.has(code), code);
  for (const code of ['provider_auth', 'context_limit', 'model_unavailable', 'git_conflict']) assert.ok(!RETRYABLE_CODES.has(code), code);
});

test('describeFailure persists a code and a readable message, and never invents one', () => {
  const failure = describeFailure(new Error('Connection error.'));
  assert.equal(failure.code, 'network_error');
  assert.match(failure.message, /network request failed/i);
  const unknown = describeFailure(new Error('some brand new thing happened'));
  assert.equal(unknown.code, null);
  assert.equal(unknown.message, 'some brand new thing happened');
  assert.deepEqual(describeFailure(Object.assign(new Error('x'), { cancelled: true })), { code: null, message: 'x' });
});

test('retry backoff is exponential and capped', () => {
  assert.equal(retryDelay(1), 5000);
  assert.equal(retryDelay(2), 10000);
  assert.equal(retryDelay(3), 20000);
  assert.equal(retryDelay(9), 60000);
  assert.equal(retryDelay(1, { baseMs: 1000, maxMs: 3000 }), 1000);
});
