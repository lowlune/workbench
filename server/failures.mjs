/* Failure classification and bounded retry policy (PLAN §40).
   Codes are inferred only from the runtime's own error text — we never invent a
   provider diagnosis — and are persisted on the command so a reload shows the
   same reason. Transient provider/network failures are retried with backoff
   instead of ending the run. */

export const FAILURE_MESSAGES = {
  model_unavailable: 'The selected model is not available for this provider. Pick another model and retry.',
  provider_unavailable: 'The model provider is temporarily unavailable. Retry in a moment or switch models.',
  provider_rate_limit: 'The provider rate limit or quota was reached. Wait a little, then retry or switch models.',
  provider_auth: 'The provider rejected the credentials (401/403). Reconnect the API key and retry.',
  context_limit: 'The request exceeded the model context window. Start a new chat, reduce the input, or switch to a larger-context model.',
  worker_crashed: 'The worker process running this task exited unexpectedly. Retry to start a fresh worker.',
  pi_failure: 'The Pi agent harness reported a failure. Retry, and check the model connection if it repeats.',
  command_failed: 'A shell command run by the agent failed. Review the command output, then retry.',
  git_conflict: 'Git could not apply the changes because of a conflict. Resolve the conflicting files and retry.',
  permission_denied: 'The agent was denied access to a file or resource.',
  attachment_failed: 'An attachment could not be read or sent.',
  network_error: 'A network request failed. Retrying automatically; check connectivity if it keeps failing.',
  restart_interrupted: 'The control plane restarted while this task was running. The recorded work is preserved; review it before continuing.',
};

/* Transient failures worth an automatic retry with backoff. Auth, context and
   model errors are terminal until the user changes something. */
export const RETRYABLE_CODES = new Set(['network_error', 'provider_unavailable', 'provider_rate_limit']);

export function classifyFailure(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return null;
  const has = (...needles) => needles.some((needle) => text.includes(needle));
  if (has('401', '403', 'unauthorized', 'invalid api key', 'invalid_api_key', 'not authenticated', 'authentication', 'api key is invalid', 'permission denied by provider')) return 'provider_auth';
  if (has('rate limit', 'rate_limit', 'ratelimit', 'too many requests', '429', 'quota exceeded', 'quota reached', 'resource_exhausted', 'usage limit', 'usage_limit', 'limit has been reached', 'limit reached', 'insufficient_quota', 'billing')) return 'provider_rate_limit';
  if (has('context length', 'context_length', 'context window', 'maximum context', 'too many tokens', 'token limit', 'max_tokens', 'prompt is too long', 'exceeds the maximum')) return 'context_limit';
  if (has('model not found', 'model_not_found', 'no such model', 'unknown model', 'model does not exist', 'does not exist', 'is not available', 'not available for', 'unsupported model', 'does not support')) return 'model_unavailable';
  if (has('merge conflict', 'git conflict', 'conflict', 'could not apply', 'patch does not apply', 'does not apply cleanly')) return 'git_conflict';
  if (has('eacces', 'eperm', 'permission denied', 'operation not permitted', 'not permitted')) return 'permission_denied';
  if (has('attachment', 'attach file', 'upload failed')) return 'attachment_failed';
  // Transport/connectivity: connection resets, DNS, timeouts and the OpenCode
  // "Cannot connect to API"/"Was there a typo in the url or port?" family.
  if (has('econnrefused', 'econnreset', 'enotfound', 'etimedout', 'eai_again', 'fetch failed', 'socket hang up', 'network error', 'connection refused', 'connection error', 'connection reset', 'cannot connect', 'unable to connect', 'connect to api', 'typo in the url', 'dns lookup', 'getaddrinfo', 'timed out', 'timeout')) return 'network_error';
  if (has('runner exited', 'runtime exited', 'could not start', 'child process', 'process exited', 'was killed', 'sigkill', 'sigterm', 'crashed', 'segmentation')) return 'worker_crashed';
  if (has('502', '503', '504', '529', 'bad gateway', 'service unavailable', 'gateway timeout', 'overloaded', 'provider is down')) return 'provider_unavailable';
  if (has('pi runner', 'pi agent', 'pi model', 'pi failure', 'pi harness', 'pi failed')) return 'pi_failure';
  if (has('exit code', 'non-zero', 'command failed', 'command exited', 'shell command')) return 'command_failed';
  if (has('interrupted_by_restart', 'control plane restarted', 'control plane stopped')) return 'restart_interrupted';
  return null;
}

export function describeFailure(error) {
  const raw = String(error?.message || error || 'The task failed.').trim() || 'The task failed.';
  if (error?.cancelled) return { code: null, message: raw };
  const code = classifyFailure(raw);
  return { code, message: code ? FAILURE_MESSAGES[code] : raw };
}

/** Exponential backoff (ms) for retry `attempt` (1-based), capped. */
export function retryDelay(attempt, { baseMs = 5000, maxMs = 60000 } = {}) {
  const step = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(maxMs, baseMs * 2 ** (step - 1));
}
