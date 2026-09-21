'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = require('../package.json');
const config = read('src/config.js');
const renderer = read('renderer/app.js');
const style = read('renderer/style.css');
const main = read('src/main.js');

assert.equal(pkg.version, '0.13.3');
assert(config.includes("themeMode: 'warm'"), 'new installs need a stable warm theme default');

for (const contract of [
  "classList.toggle('theme-dark'",
  "classList.toggle('theme-system'",
  "select id=\"s-theme\"",
  "saveSettings({ themeMode: theme.value }",
  'overview-actions',
  'overview-primary',
  'utility-actions',
  'project-tools',
  'activity-archive',
  'recentArchiveOpen',
]) {
  assert(renderer.includes(contract), 'missing v0.13.3 renderer contract: ' + contract);
}

for (const token of [
  '--surface:', '--surface-secondary:', '--text:', '--text-secondary:', '--border:',
  '--fill-hover:', '--shadow-floating:', 'body.theme-dark', 'body.theme-system',
  '.overview-primary', '.project-tools-grid', '.activity-archive',
]) {
  assert(style.includes(token), 'missing semantic visual token or component: ' + token);
}

assert(main.includes("captureView === 'theme-dark'"), 'dark theme must have visual capture coverage');
assert.equal((renderer.match(/id="p-new-session"/g) || []).length, 1, 'project page must not duplicate session action IDs');
assert.equal((renderer.match(/id="p-reset-context"/g) || []).length, 1, 'project page must not duplicate reset action IDs');

console.log('v0.13.3 semantic theme, hierarchy and disclosure contracts passed');
