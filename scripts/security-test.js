'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openablePath } = require('../src/path-safety');
const { pickKeys, RENDERER_SETTINGS, RENDERER_UI, delegationEngine } = require('../src/ipc-guards');
const { ensureUserProviderConfig, PROVIDER_ID } = require('../src/codex-transport');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-security-test-'));
try {
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'report.md'), '# ok\n');
  fs.writeFileSync(path.join(project, 'payload.exe'), 'MZ');
  fs.writeFileSync(path.join(project, 'run.CMD'), 'echo');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

  // shell:open only reaches documents and folders inside trusted roots.
  assert.equal(openablePath(path.join(project, 'docs', 'report.md'), [project]), fs.realpathSync(path.join(project, 'docs', 'report.md')));
  assert.equal(openablePath(project, [project]), fs.realpathSync(project));
  assert.equal(openablePath(path.join(project, 'payload.exe'), [project]), null, 'executables must never be launched');
  assert.equal(openablePath(path.join(project, 'run.CMD'), [project]), null, 'extension check is case-insensitive');
  assert.equal(openablePath(path.join(outside, 'secret.txt'), [project]), null);
  assert.equal(openablePath(path.join(project, '..', 'outside', 'secret.txt'), [project]), null, 'dot segments cannot escape');
  assert.equal(openablePath(path.join(project, 'missing.md'), [project]), null);
  assert.equal(openablePath('docs/report.md', [project]), null, 'relative paths are refused');
  assert.equal(openablePath(42, [project]), null);
  if (process.platform === 'win32') {
    const junction = path.join(project, 'escape');
    const made = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', junction, outside], { windowsHide: true });
    if (made.status === 0) assert.equal(openablePath(path.join(junction, 'secret.txt'), [project]), null, 'junctions cannot escape a root');
  }

  // Renderer patches cannot write arbitrary state keys.
  assert.deepEqual(pickKeys({ themeMode: 'dark', projects: [], __proto__: { polluted: true }, caps: { a: 1 } }, RENDERER_SETTINGS), { themeMode: 'dark' });
  assert.deepEqual(pickKeys({ hiddenPets: ['w1'], activeProjectId: 'x' }, RENDERER_UI), { hiddenPets: ['w1'] });
  assert.deepEqual(pickKeys(null, RENDERER_UI), {});
  assert.deepEqual(pickKeys(['themeMode'], RENDERER_SETTINGS), {});
  assert.equal(delegationEngine('ruflo'), 'ruflo');
  assert.equal(delegationEngine('anything-else'), 'local');

  // Writing the user's global Codex config always leaves a restorable backup.
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(codexHome);
  const original = 'model = "gpt-5"\r\n[profiles.x]\r\nmodel = "y"\r\n';
  fs.writeFileSync(path.join(codexHome, 'config.toml'), original);
  const first = ensureUserProviderConfig(true, codexHome);
  assert.equal(first.changed, true);
  assert.ok(first.backup && fs.existsSync(first.backup));
  assert.equal(fs.readFileSync(first.backup, 'utf8'), original);
  const written = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.ok(written.startsWith(original), 'existing configuration is preserved byte-for-byte');
  assert.ok(written.includes('[model_providers.' + PROVIDER_ID + ']'));
  assert.equal(ensureUserProviderConfig(true, codexHome).changed, false, 'second sync is idempotent');
  assert.equal(fs.readdirSync(codexHome).filter(name => name.includes('pet-office-backup')).length, 1, 'no backup when nothing changes');
  assert.equal(fs.readdirSync(codexHome).some(name => name.endsWith('.pet-office-next')), false);
  const fresh = path.join(root, 'codex-empty');
  fs.mkdirSync(fresh);
  assert.equal(ensureUserProviderConfig(true, fresh).backup, null, 'nothing to back up for a new config');

  // The renderer document must declare a strict script policy.
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /connect-src 'none'/);

  console.log('security: openPath guard, renderer patch filtering, Codex config backup and CSP OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
