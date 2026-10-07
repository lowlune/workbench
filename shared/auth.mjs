export const COOKIE = 'workbench_session';
export const SESSION_TTL = 14 * 24 * 60 * 60;
const encoder = new TextEncoder();
const signingKey = secret => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const equals = part.indexOf('=');
    if (equals >= 0 && part.slice(0, equals).trim() === name) return part.slice(equals + 1).trim();
  }
  return '';
}

export async function newSession(secret) {
  if (!secret) throw new Error('Session signing is not configured.');
  const payload = `${Math.floor(Date.now() / 1000) + SESSION_TTL}.${encode(crypto.getRandomValues(new Uint8Array(18)))}`;
  return `${payload}.${encode(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload)))}`;
}

export async function hasSession(token, secret) {
  if (!secret || typeof token !== 'string' || token.length > 512) return false;
  const [expires, nonce, signature, extra] = token.split('.');
  if (!/^\d+$/.test(expires || '') || !/^[A-Za-z0-9_-]+$/.test(nonce || '') || !/^[A-Za-z0-9_-]+$/.test(signature || '') || extra !== undefined) return false;
  if (!Number.isSafeInteger(Number(expires)) || Number(expires) <= Math.floor(Date.now() / 1000)) return false;
  try { return await crypto.subtle.verify('HMAC', await signingKey(secret), decode(signature), encoder.encode(`${expires}.${nonce}`)); }
  catch { return false; }
}

export async function matchesSecret(candidate, expected) {
  if (!expected || typeof candidate !== 'string' || !candidate || candidate.length > 4096) return false;
  // WebCrypto verifies the MAC in native code on both Node and Workers, without
  // a JavaScript string comparison or a Worker-only crypto extension.
  const challenge = encoder.encode('workbench-secret-comparison-v1');
  const comparisonKey = async value => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(value)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', await comparisonKey(candidate), challenge);
  return crypto.subtle.verify('HMAC', await comparisonKey(expected), signature, challenge);
}

export async function matchesPassword(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length > 256 || !expected) return false;
  return matchesSecret(candidate.replace(/[\s-]/g, '').toLowerCase(), String(expected).replace(/[\s-]/g, '').toLowerCase());
}

export function sessionCookie(value, maxAge = SESSION_TTL) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
