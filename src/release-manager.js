'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function versionParts(value) {
  return String(value || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number(part) || 0);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

async function checkLatestRelease({ currentVersion, repository = 'Gu-kai-lei/Open-Pet-Office', fetchImpl = global.fetch, timeoutMs = 7000 } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行时不支持更新检查。' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.github.com/repos/' + repository + '/releases/latest', {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Open-Pet-Office/' + currentVersion },
    });
    if (!response.ok) throw new Error('GitHub 返回 HTTP ' + response.status);
    const release = await response.json();
    const latestVersion = String(release.tag_name || release.name || '').replace(/^v/i, '');
    if (!latestVersion) throw new Error('发布信息缺少版本号');
    const asset = (release.assets || []).find(item => /portable\.exe$/i.test(item.name || '')) || null;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url || 'https://github.com/' + repository + '/releases/latest',
      downloadUrl: asset && asset.browser_download_url || null,
      publishedAt: release.published_at || null,
    };
  } catch (error) {
    return { ok: false, currentVersion, error: error.name === 'AbortError' ? '更新检查超时' : String(error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function inspectWindowsSignature(executable, timeoutMs = 6000) {
  if (process.platform !== 'win32') return Promise.resolve({ status: 'unsupported', signed: false, detail: '仅 Windows 支持签名检查' });
  return new Promise(resolve => {
    const script = '$s=Get-AuthenticodeSignature -LiteralPath $args[0]; [pscustomobject]@{Status=[string]$s.Status;Subject=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{$null}} | ConvertTo-Json -Compress';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, executable], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 'unknown', signed: false, detail: String(error.message || error).slice(0, 180) });
      return;
    }
    let output = '';
    let errorText = '';
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', data => { errorText += data.toString(); });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ status: 'unknown', signed: false, detail: '签名检查超时' }); }, timeoutMs);
    child.on('error', error => finish({ status: 'unknown', signed: false, detail: String(error.message || error).slice(0, 180) }));
    child.on('exit', () => {
      try {
        const result = JSON.parse(output.trim());
        const signed = result.Status === 'Valid';
        finish({ status: result.Status || 'Unknown', signed, detail: signed ? (result.Subject || '签名有效') : '未检测到有效代码签名' });
      } catch {
        finish({ status: 'unknown', signed: false, detail: (errorText || output || '无法读取签名状态').replace(/\s+/g, ' ').slice(0, 180) });
      }
    });
  });
}

function crashReportSummary(crashDir) {
  try {
    const files = fs.readdirSync(crashDir).filter(name => /\.(json|dmp)$/i.test(name));
    let latestAt = 0;
    for (const name of files) {
      try { latestAt = Math.max(latestAt, fs.statSync(path.join(crashDir, name)).mtimeMs); } catch {}
    }
    return { count: files.length, latestAt: latestAt || null, path: crashDir };
  } catch {
    return { count: 0, latestAt: null, path: crashDir };
  }
}

module.exports = { compareVersions, checkLatestRelease, inspectWindowsSignature, crashReportSummary };
