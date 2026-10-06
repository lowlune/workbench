import { fail, uid, decode } from './store.mjs';

/* Usage limits + pacing (PLAN §30–§32).

   Limits are entered by the user (manual) or, when a provider reports real
   quota, stored as `reported`. Usage is computed from the durable ledger and is
   therefore `estimated`; we never invent provider limits. `expected` is the
   linear budget burn for the elapsed part of the period, `actual` is measured
   usage, and pacing compares the two. */

const DAY = 86400000;
const PERIODS = { weekly: 7 * DAY, monthly: 30 * DAY };

export function periodSpan(period) {
  return PERIODS[period] || PERIODS.monthly;
}

/* If reset_at is set it marks a recurring boundary; otherwise the period is a
   rolling window ending now. */
export function currentWindow(limit, now = Date.now()) {
  const span = periodSpan(limit.period);
  const anchor = Number(limit.reset_at);
  if (!Number.isFinite(anchor) || anchor <= 0) {
    return { from: now - span, to: now, resetAt: null, span, elapsed: 1, rolling: true };
  }
  const start = anchor + Math.floor((now - anchor) / span) * span;
  const end = start + span;
  return { from: start, to: end, resetAt: end, span, elapsed: Math.min(1, Math.max(0, (now - start) / span)), rolling: false };
}

export function listLimits(store) {
  return store.db.prepare('SELECT * FROM usage_limits ORDER BY created').all().map(serializeLimit);
}

export function serializeLimit(row) {
  return {
    id: row.id,
    scope: row.scope,
    provider: row.provider || null,
    period: row.period,
    limitTokens: row.limit_tokens ?? null,
    limitCost: row.limit_cost ?? null,
    manual: !!row.manual,
    resetAt: row.reset_at ?? null,
    reported: decode(row.reported, null),
    created: row.created,
    updated: row.updated,
  };
}

export function upsertLimit(store, input) {
  const id = typeof input.id === 'string' && /^[\w-]{6,80}$/.test(input.id) ? input.id : uid('lim_');
  const scope = input.scope === 'provider' ? 'provider' : 'global';
  if (scope === 'provider' && !/^[a-z0-9._-]{1,80}$/.test(input.provider || '')) throw fail('Choose a provider for a provider limit.');
  const period = input.period === 'weekly' ? 'weekly' : 'monthly';
  const limitTokens = Number.isFinite(Number(input.limitTokens)) && Number(input.limitTokens) > 0 ? Math.round(Number(input.limitTokens)) : null;
  const limitCost = Number.isFinite(Number(input.limitCost)) && Number(input.limitCost) > 0 ? Number(input.limitCost) : null;
  if (limitTokens === null && limitCost === null) throw fail('Set a token or cost limit.');
  const resetAt = Number.isFinite(Number(input.resetAt)) && Number(input.resetAt) > 0 ? Math.round(Number(input.resetAt)) : null;
  const reported = input.reported && typeof input.reported === 'object' ? JSON.stringify({ ...input.reported, at: input.reported.at || Date.now() }).slice(0, 20000) : null;
  const now = Date.now();
  const existing = store.db.prepare('SELECT id FROM usage_limits WHERE id=?').get(id);
  if (existing) {
    store.db.prepare(`UPDATE usage_limits SET scope=?,provider=?,period=?,limit_tokens=?,limit_cost=?,manual=?,reset_at=?,reported=?,updated=? WHERE id=?`)
      .run(scope, scope === 'provider' ? input.provider : null, period, limitTokens, limitCost, Number(input.manual === false ? 0 : 1), resetAt, reported, now, id);
  } else {
    store.db.prepare(`INSERT INTO usage_limits(id,scope,provider,period,limit_tokens,limit_cost,manual,reset_at,reported,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, scope, scope === 'provider' ? input.provider : null, period, limitTokens, limitCost, Number(input.manual === false ? 0 : 1), resetAt, reported, now, now);
  }
  return serializeLimit(store.db.prepare('SELECT * FROM usage_limits WHERE id=?').get(id));
}

export function removeLimit(store, id) {
  const result = store.db.prepare('DELETE FROM usage_limits WHERE id=?').run(id);
  if (!result.changes) throw fail('Limit not found.', 404);
  return { deleted: true };
}

function usageFor(store, limit, window) {
  const filter = limit.scope === 'provider' && limit.provider ? ' AND u.provider=?' : '';
  const args = limit.scope === 'provider' && limit.provider ? [window.from, limit.provider] : [window.from];
  return store.db.prepare(`SELECT count(*) AS requests,
      coalesce(sum(u.input),0) AS input, coalesce(sum(u.output),0) AS output,
      coalesce(sum(u.cache_read),0) AS cacheRead, coalesce(sum(u.cache_write),0) AS cacheWrite,
      sum(u.cost) AS cost, sum(u.cost IS NULL) AS unknownCost
    FROM usage u WHERE u.created>=?${filter}`).get(...args);
}

export function pacingFor(store, limit, now = Date.now()) {
  const window = currentWindow(limit, now);
  const usage = usageFor(store, limit, window);
  const tokens = Number(usage.input) + Number(usage.output);
  const tokensWithCache = tokens + Number(usage.cacheRead) + Number(usage.cacheWrite);
  const cost = usage.cost === null || usage.cost === undefined ? null : Number(usage.cost);
  const expectedTokens = limit.limitTokens ? Math.round(limit.limitTokens * window.elapsed) : null;
  const expectedCost = limit.limitCost ? Number((limit.limitCost * window.elapsed).toFixed(4)) : null;
  const tokenFraction = limit.limitTokens ? tokens / limit.limitTokens : null;
  const costFraction = limit.limitCost && cost !== null ? cost / limit.limitCost : null;
  const worst = Math.max(tokenFraction || 0, costFraction || 0);
  let status = 'ok';
  if (worst >= 1) status = 'over';
  else if (worst >= 0.9) status = 'warn';
  else if (tokenFraction !== null && expectedTokens && tokens > expectedTokens * 1.1) status = 'ahead';
  else if (costFraction !== null && expectedCost && cost !== null && cost > expectedCost * 1.1) status = 'ahead';
  const projectedTokens = window.elapsed > 0 ? Math.round(tokens / window.elapsed) : null;
  const projectedCost = cost !== null && window.elapsed > 0 ? Number((cost / window.elapsed).toFixed(4)) : null;
  return {
    limitId: limit.id,
    scope: limit.scope,
    provider: limit.provider || null,
    period: limit.period,
    manual: !!limit.manual,
    limitSource: limit.manual ? 'manual' : 'provider',
    usageSource: limit.reported ? 'reported' : 'estimated',
    reported: limit.reported || null,
    windowFrom: window.from,
    windowTo: window.to,
    resetAt: window.resetAt,
    rolling: !!window.rolling,
    elapsed: Number(window.elapsed.toFixed(4)),
    actual: {
      tokens,
      tokensWithCache,
      cost,
      requests: Number(usage.requests),
      unknownCostRequests: Number(usage.unknownCost || 0),
    },
    limit: { tokens: limit.limitTokens, cost: limit.limitCost },
    expected: { tokens: expectedTokens, cost: expectedCost },
    remaining: {
      tokens: limit.limitTokens ? Math.max(0, limit.limitTokens - tokens) : null,
      cost: limit.limitCost !== null && limit.limitCost !== undefined && cost !== null ? Math.max(0, Number((limit.limitCost - cost).toFixed(4))) : null,
    },
    projected: { tokens: projectedTokens, cost: projectedCost },
    fraction: { tokens: tokenFraction === null ? null : Number(tokenFraction.toFixed(4)), cost: costFraction === null ? null : Number(costFraction.toFixed(4)) },
    status,
  };
}

export function pacing(store, now = Date.now()) {
  return listLimits(store).map((limit) => pacingFor(store, limit, now));
}
