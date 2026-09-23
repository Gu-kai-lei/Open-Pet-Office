'use strict';
const fs = require('fs');
const { ADMIN_TOKEN_FILE, PROXY_BASE, log } = require('./config');

let cache = { at: 0, lastSuccessAt: 0, ok: false, stale: false, reports: [], error: null, retryAt: 0 };
let failureCount = 0;

function failureBackoffMs(count) {
  return Math.min(30 * 60 * 1000, 30 * 1000 * (2 ** Math.max(0, Math.min(6, count - 1))));
}

async function fetchQuotas(force = false) {
  const now = Date.now();
  if (!force && cache.ok && now - cache.at < 45000) return cache;
  if (!force && cache.retryAt && now < cache.retryAt) return cache;
  let token = '';
  try {
    token = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    cache = {
      at: now,
      lastSuccessAt: cache.lastSuccessAt || 0,
      ok: false,
      stale: !!(cache.reports && cache.reports.length),
      reports: cache.reports || [],
      error: '无法读取管理令牌: ' + e.message,
      retryAt: now + failureBackoffMs(++failureCount),
    };
    return cache;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res;
    try {
      res = await fetch(PROXY_BASE + '/api/provider-quotas', {
        headers: { 'X-OpenCodex-API-Key': token },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    failureCount = 0;
    cache = { at: now, lastSuccessAt: now, ok: true, stale: false, error: null, reports: normalize(data.reports || []), retryAt: 0 };
  } catch (e) {
    const message = e && e.name === 'AbortError' ? '请求超时' : e.message;
    cache = {
      at: now,
      lastSuccessAt: cache.lastSuccessAt || 0,
      ok: false,
      stale: !!(cache.reports && cache.reports.length),
      reports: cache.reports || [],
      error: message,
      retryAt: now + failureBackoffMs(++failureCount),
    };
    log('quota fetch failed: ' + message);
  }
  return cache;
}

function normalize(reports) {
  return reports.map(r => {
    const q = r.quota || {};
    const out = { provider: r.provider, label: r.label || r.provider, kind: 'unknown', updatedAt: r.updatedAt || null };
    if (typeof q.fiveHourPercent === 'number') {
      out.kind = 'codex';
      out.fiveHourUsed = q.fiveHourPercent;
      out.weeklyUsed = typeof q.weeklyPercent === 'number' ? q.weeklyPercent : null;
      const agg = (r.aggregation && r.aggregation.currentAccount && r.aggregation.currentAccount.quota) || {};
      out.fiveHourResetAt = agg.fiveHourResetAt || null;
      out.weeklyResetAt = agg.weeklyResetAt || null;
    } else if (Array.isArray(q.customWindows) && q.customWindows.length) {
      out.kind = 'balance';
      out.balanceText = q.customWindows[0].label || '';
    }
    return out;
  });
}

module.exports = { fetchQuotas, _internals: { failureBackoffMs } };
