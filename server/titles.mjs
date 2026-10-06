import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* One small non-reasoning model call per conversation to name it. Runs
   outside the agent loop, never blocks a turn, and degrades to the first
   user message when the provider is unavailable. Usage is recorded by the
   caller so the ledger stays complete. */

const HOME = process.env.HOME || os.homedir();
const AUTH_FILE = path.join(HOME, '.local/share/opencode/auth.json');
const BASE_URL = 'https://opencode.ai/zen/go/v1';
const FAST_MODEL = 'deepseek-v4-flash';

function sanitizeTitle(value) {
  return String(value || '')
    .replace(/["'“”`]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/, '')
    .trim()
    .slice(0, 72);
}

export async function generateTitle({ conversationId, firstUserText }) {
  let key = '';
  try {
    const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    key = typeof auth['opencode-go']?.key === 'string' ? auth['opencode-go'].key : '';
  } catch {}
  if (!key) return null;
  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-opencode-session': conversationId,
      },
      body: JSON.stringify({
        model: FAST_MODEL,
        messages: [
          { role: 'system', content: 'You name coding conversations. Reply with a 3 to 6 word title only. No quotes, no punctuation at the end, no explanation.' },
          { role: 'user', content: `First user message:\n${String(firstUserText || '').slice(0, 2000)}\n\nTitle:` },
        ],
        max_tokens: 512,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const title = sanitizeTitle(data.choices?.[0]?.message?.content || '');
    if (!title) return null;
    return {
      title,
      model: `opencode-go/${FAST_MODEL}`,
      usage: data.usage || null,
    };
  } catch {
    return null;
  }
}
