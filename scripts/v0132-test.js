'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = require('../package.json');
const renderer = read('renderer/app.js');
const style = read('renderer/style.css');
const main = read('src/main.js');

assert.ok(pkg.version === '0.13.2' || pkg.version.startsWith('0.13.3'), 'v0.13.2 contracts must remain in later patch releases');

for (const contract of [
  "element.classList.toggle('hidden', !mode)",
  "composer.classList.remove('morphing')",
  'duration + 90',
]) {
  assert(renderer.includes(contract), 'missing composer recovery contract: ' + contract);
}
assert(renderer.includes('const composerSurface = { epoch: 0, timer: null, animation: null }'));

for (const contract of ['answerDrafts', 'openMissions', 'focusedAnswer', 'refreshOpenPanelForLiveState']) {
  assert(renderer.includes(contract), 'missing live refresh preservation contract: ' + contract);
}
assert(renderer.includes('missionAt >= taskAt'), 'live task and Mission must be ordered by freshness');
assert(renderer.includes('projectSessionCache.has(project.id) ? sessions.length'), 'project count must use loaded sessions');
assert(renderer.includes("aria-roledescription', '桌宠'"), 'nested desktop pet controls need a group role');

assert(main.includes("cancelCaptureWait('superseded')"), 'capture retry must supersede stale waiters');
assert(main.includes('Date.now() - startedAt > 30000'), 'capture timeout must be bounded');
assert(style.includes('input:focus-visible, textarea:focus-visible, select:focus-visible'));

console.log('v0.13.2 UI race, state preservation, capture retry and readability contracts passed');
