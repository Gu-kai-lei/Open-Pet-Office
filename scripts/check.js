'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const files = [
  'src/config.js',
  'src/catalog.js',
  'src/quota.js',
  'src/dispatcher.js',
  'src/planner.js',
  'src/bridge.js',
  'src/appserver.js',
  'src/session-monitor.js',
  'src/inbox.js',
  'src/main.js',
  'src/preload.js',
  'renderer/app.js',
  'scripts/appserver-smoke.js',
  'scripts/approval-smoke.js',
  'scripts/dispatcher-progress-smoke.js',
  'scripts/conversation-recovery-test.js',
  'scripts/appserver-progress-test.js',
  'scripts/session-monitor-test.js',
  'scripts/activity-state-test.js',
  'scripts/inbox-test.js',
];

let failed = false;
for (const file of files) {
  try {
    new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
    console.log('OK   ' + file);
  } catch (error) {
    failed = true;
    console.error('FAIL ' + file + '\n' + error.stack);
  }
}

if (failed) process.exit(1);
