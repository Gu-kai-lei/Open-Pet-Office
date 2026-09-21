'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeDroppedLinks, safeHttpUrl } = require('../src/link-utils');

const root = path.resolve(__dirname, '..');

function main() {
  const links = normalizeDroppedLinks({
    uriList: '# browser drag\nhttps://canvas.example.edu/courses/42/assignments/9?access_token=secret',
    plain: 'Also see https://docs.example.edu/guide and javascript:alert(1)',
    html: '<a href="https://canvas.example.edu/courses/42">Week 3 assignment</a>',
  });
  assert.strictEqual(links.length, 3);
  assert.strictEqual(links[0].name, 'Week 3 assignment');
  assert(links.some(item => item.domain === 'docs.example.edu'));
  assert(!JSON.stringify(links).includes('secret'));
  assert.strictEqual(safeHttpUrl('file:///C:/private.txt'), null);
  assert.strictEqual(safeHttpUrl('javascript:alert(1)'), null);

  const duplicate = normalizeDroppedLinks({
    uriList: 'https://example.test/a',
    plain: 'https://example.test/a',
    html: '<a href="https://example.test/a">A</a>',
  });
  assert.strictEqual(duplicate.length, 1);

  const config = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert(config.includes("captureShortcut: 'Control+Alt+S'"));
  for (const contract of ["'capture:start'", "'capture:ready'", "'links:normalize'", "'ms-screenclip:'"]) assert(mainSource.includes(contract), 'missing main contract: ' + contract);
  for (const contract of ['startCapture', 'normalizeLinks', 'openExternal']) assert(preload.includes(contract), 'missing preload contract: ' + contract);
  for (const contract of ['receiveDroppedLinks', 'composerVisionWarning', '/截图', 'capture:ready', 'text/uri-list']) assert(renderer.includes(contract), 'missing renderer contract: ' + contract);
  assert(renderer.includes("const blockingOverlay = ['#composer', '#panel', '#ctxmenu']"), 'live task card must stay hidden behind active overlays');
  assert(renderer.includes('const leftCandidate = Math.round(petBox.left - width - 14)'), 'bottom-edge composer must move beside the pet');

  console.log('v0.13.1 dropped-link and screenshot-input contracts passed');
}

main();
