import { readCookie, hasSession, newSession, matchesPassword, sessionCookie } from './shared/auth.mjs';
const PUBLIC_LOGIN_ASSETS = new Set([
  '/login.html',
  '/login.css',
  '/login.js',
  '/fonts/inter.css',
  '/fonts/inter-latin-wght-normal.woff2',
]);

function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

async function loginAsset(env, assetPath = '/login.html') {
  const assetUrl = new URL(assetPath, 'http://localhost');
  try {
    const response = await env.ASSETS.fetch(new Request(assetUrl, { method: 'GET' }));
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return new Response('Workbench sign-in is temporarily unavailable.', {
      status: 502,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}

/* The shell, fonts and hashed assets come straight from the edge; only the
   API and its event stream travel to the VPS. */
async function staticAsset(request, env, url) {
  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (url.pathname === '/' || url.pathname.endsWith('.html')) headers.set('Cache-Control', 'no-cache');
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

async function recordLoginAttempt(request, env, success) {
  if (!env.WORKBENCH_PROXY_KEY) throw new Error('Login protection is not configured.');
  const target = new URL('/api/internal/login-attempt', 'http://localhost:8787');
  const response = await env.WORKBENCH_API.fetch(new Request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workbench-internal-key': env.WORKBENCH_PROXY_KEY,
    },
    body: JSON.stringify({
      ip: request.headers.get('cf-connecting-ip') || 'unknown',
      success,
    }),
  }));
  if (!response.ok) throw new Error('Login protection is temporarily unavailable.');
  return response.json();
}

async function proxyApi(request, env, url) {
  const target = new URL(`${url.pathname}${url.search}`, 'http://localhost:8787');
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  headers.delete('authorization');
  headers.delete('x-workbench-internal-key');
  headers.delete('host');
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-workbench-internal-key', env.WORKBENCH_PROXY_KEY);

  const init = { method: request.method, headers, redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  try {
    const response = await env.WORKBENCH_API.fetch(new Request(target, init));
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch {
    return json({ error: 'Workbench on the VPS is temporarily unavailable.' }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') {
      url.protocol = 'https:';
      url.port = '';
      return Response.redirect(url, 308);
    }
    if (url.hostname === 'workbench.ocu.workers.dev') {
      url.hostname = 'w.ocu.workers.dev';
      return Response.redirect(url, 308);
    }
    const path = url.pathname;

    // Fail closed before secrets are installed; never serve a public unprotected app.
    if (!env.WORKBENCH_LOGIN || !env.WORKBENCH_SESSION_SECRET || !env.WORKBENCH_PROXY_KEY) {
      return new Response('Workbench access is not initialized.', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (path === '/login' || path === '/login.html') return loginAsset(env);
    if (PUBLIC_LOGIN_ASSETS.has(path) && request.method === 'GET') return loginAsset(env, path);

    if (path === '/auth/login' && request.method === 'POST') {
      let password = '';
      try {
        const form = await request.formData();
        password = String(form.get('password') || '');
      } catch {
        return Response.redirect(new URL('/login?error=1', url), 303);
      }
      const validPassword = await matchesPassword(password, env.WORKBENCH_LOGIN);
      let attempt;
      try {
        attempt = await recordLoginAttempt(request, env, validPassword);
      } catch {
        return json({ error: 'Login protection is temporarily unavailable.' }, 503);
      }
      if (!attempt.allowed) {
        const page = await loginAsset(env);
        const headers = new Headers(page.headers);
        headers.set('Retry-After', String(attempt.retryAfter || 60));
        headers.set('Cache-Control', 'no-store');
        return new Response(page.body, { status: 429, statusText: 'Too Many Requests', headers });
      }
      if (!validPassword) {
        return Response.redirect(new URL('/login?error=1', url), 303);
      }
      const token = await newSession(env.WORKBENCH_SESSION_SECRET);
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': sessionCookie(token),
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    }

    if (path === '/logout' && request.method === 'GET') {
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/login',
          'Set-Cookie': sessionCookie('', 0),
          'Cache-Control': 'no-store',
        },
      });
    }

    if (!(await hasSession(readCookie(request.headers.get('cookie')), env.WORKBENCH_SESSION_SECRET))) {
      if (path.startsWith('/api/')) return json({ error: 'Sign in to Workbench.' }, 401);
      return Response.redirect(new URL('/login', url), 302);
    }

    if (path.startsWith('/api/')) return proxyApi(request, env, url);
    return staticAsset(request, env, url);
  },
};
