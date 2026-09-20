'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compareVersions, checkLatestRelease, crashReportSummary } = require('../src/release-manager');
const { isFullscreenBounds } = require('../src/fullscreen-probe');

async function main() {
  assert.strictEqual(compareVersions('0.13.0', '0.12.9'), 1);
  assert.strictEqual(compareVersions('v0.13.0', '0.13.0'), 0);
  assert.strictEqual(compareVersions('0.12.9', '0.13.0'), -1);

  const update = await checkLatestRelease({
    currentVersion: '0.13.0',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tag_name: 'v0.14.0', html_url: 'https://example.test/release', published_at: '2026-09-20T00:00:00Z',
        assets: [{ name: 'Pet-Office-0.14.0-portable.exe', browser_download_url: 'https://example.test/app.exe' }],
      }),
    }),
  });
  assert.strictEqual(update.ok, true);
  assert.strictEqual(update.updateAvailable, true);
  assert.strictEqual(update.downloadUrl, 'https://example.test/app.exe');

  assert.strictEqual(isFullscreenBounds({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }), true);
  assert.strictEqual(isFullscreenBounds({ x: 10, y: 0, width: 1900, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }), false);
  assert.strictEqual(isFullscreenBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, { x: -1920, y: 0, width: 1920, height: 1080 }), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-v013-'));
  fs.writeFileSync(path.join(dir, 'one.json'), '{}');
  fs.writeFileSync(path.join(dir, 'two.dmp'), 'x');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'x');
  const report = crashReportSummary(dir);
  assert.strictEqual(report.count, 2);
  assert.strictEqual(report.path, dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
  for (const setting of ['displayMode', 'fullscreenBehavior', 'notificationMode', 'fontScale', 'fontFamily', 'autoCheckUpdates']) {
    assert(configSource.includes(setting), 'missing setting: ' + setting);
  }
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  for (const feature of ['desktop:display', 'desktop:fullscreen', 'release:update', 'attachment-card', 'bubbleAllowed']) {
    assert(rendererSource.includes(feature), 'missing renderer feature: ' + feature);
  }
  console.log('v0.13 release, fullscreen, crash and renderer contracts passed');
}

main().catch(error => { console.error(error); process.exit(1); });
