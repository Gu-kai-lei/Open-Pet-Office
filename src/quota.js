'use strict';
const fs = require('fs');
const { ADMIN_TOKEN_FILE, PROXY_BASE, log } = require('./config');

let cache = { at: 0, ok: false, reports: [], error: null };

async function fetchQuotas(force = false) {
  const now = Date.now();
  if (!force && cache.ok && now - cache.at < 45000) return cache;
  let token = '';
  try {
    token = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
  } catch (e) {
    cache = { at: now, ok: false, reports: cache.reports || [], error: '无法读取管理令牌: ' + e.message };
    return cache;
  }
  try {
    const res = await fetch(PROXY_BASE + '/api/provider-quotas', { headers: { 'X-OpenCodex-API-Key': token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cache = { at: now, ok: true, error: null, reports: normalize(data.reports || []) };
  } catch (e) {
    cache = { at: now, ok: false, reports: cache.reports || [], error: e.message };
    log('quota fetch failed: ' + e.message);
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

module.exports = { fetchQuotas };
