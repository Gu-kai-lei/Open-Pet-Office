'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { CATALOG_FILE, ADMIN_TOKEN_FILE, PROXY_BASE, CODEX_HOME } = require('./config');

function safeText(value, limit = 220) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[已隐藏]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[已隐藏]')
    .replace(/\b(api[_ -]?key|access[_ -]?token|token|auth(?:orization)?|password|passwd|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[已隐藏]')
    .replace(/([?&](?:key|token|secret|password)=)[^&#\s]+/gi, '$1[已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function commandVersion(timeoutMs = 5000) {
  return new Promise(resolve => {
    let child;
    try {
      child = process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', 'codex --version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, detail: safeText(error.message) });
      return;
    }
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { output += data.toString(); });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, detail: '检测超时' });
    }, timeoutMs);
    child.on('error', error => finish({ ok: false, detail: safeText(error.message) }));
    child.on('exit', code => finish({ ok: code === 0, detail: safeText(output) || ('退出码 ' + code) }));
  });
}

async function proxyHealth(timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(PROXY_BASE + '/health', { signal: controller.signal });
    return { ok: response.status < 500, status: response.status, detail: 'HTTP ' + response.status };
  } catch (error) {
    return { ok: false, status: null, detail: error && error.name === 'AbortError' ? '连接超时' : safeText(error.message) };
  } finally {
    clearTimeout(timer);
  }
}

function status(ok, warning = false) {
  return ok ? 'ok' : (warning ? 'warning' : 'error');
}

async function collectDiagnostics({ appServerHealth = {}, desktopMonitorHealth = {}, quotaCache = {} } = {}) {
  const [codex, proxy] = await Promise.all([commandVersion(), proxyHealth()]);
  let modelCount = 0;
  let catalogExists = false;
  try {
    catalogExists = fs.existsSync(CATALOG_FILE);
    const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    modelCount = Array.isArray(catalog.models) ? catalog.models.length : 0;
  } catch {}
  const sessionsPath = require('path').join(CODEX_HOME, 'sessions');
  const appError = safeText(appServerHealth.lastError);
  const websocketUnsupported = /426|upgrade required|websocket/i.test(appError);
  const activeWriter = /active writer|already has .*writer/i.test(appError);
  return {
    checkedAt: Date.now(),
    items: [
      { id: 'codex', label: 'Codex CLI', status: status(codex.ok), detail: codex.detail || '不可用' },
      {
        id: 'catalog',
        label: '模型目录',
        status: modelCount > 0 ? 'ok' : (catalogExists ? 'warning' : 'error'),
        detail: modelCount ? modelCount + ' 个模型' : (catalogExists ? '文件存在但暂不可读，当前仅显示 Codex 默认模型' : '未找到 OpenCodex 模型目录'),
      },
      { id: 'proxy', label: 'OpenCodex 代理', status: status(proxy.ok, proxy.status === 404), detail: proxy.ok ? '本地代理可访问 · ' + proxy.detail : proxy.detail },
      { id: 'token', label: '额度管理令牌', status: status(fs.existsSync(ADMIN_TOKEN_FILE), true), detail: fs.existsSync(ADMIN_TOKEN_FILE) ? '已配置' : '未配置；额度功能不可用' },
      { id: 'quota', label: '额度接口', status: status(!!quotaCache.ok, !!quotaCache.stale), detail: quotaCache.ok ? '最近刷新成功' : (quotaCache.stale ? '当前显示缓存 · ' + safeText(quotaCache.error) : safeText(quotaCache.error || '尚未成功刷新')) },
      { id: 'sessions', label: 'Codex 任务监听', status: status(fs.existsSync(sessionsPath) && desktopMonitorHealth.ok !== false, fs.existsSync(sessionsPath)), detail: desktopMonitorHealth.ok === false ? safeText(desktopMonitorHealth.error) : '会话目录可读' },
      {
        id: 'appserver',
        label: '桌宠会话服务',
        status: activeWriter || websocketUnsupported ? 'warning' : (!appError ? 'ok' : (appServerHealth.running ? 'warning' : 'error')),
        detail: activeWriter ? '线程正由另一个 Codex 客户端写入' : (websocketUnsupported ? '代理不支持 Realtime WebSocket，需使用兼容传输' : (appServerHealth.running ? (appError || '运行中') : (appError || '按需启动'))),
      },
    ],
  };
}

module.exports = { collectDiagnostics, _internals: { safeText, commandVersion, proxyHealth } };
