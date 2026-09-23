'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const start = source.indexOf('function matchesActivityView(');
const end = source.indexOf('\nfunction ', start + 1);
const context = vm.createContext({ activityView: 'all' });
vm.runInContext(source.slice(start, end), context);
const select = (view, records, mission = false) => {
  context.activityView = view;
  return records.filter(item => context.matchesActivityView(item, mission)).map(item => item.id);
};
const tasks = [
  { id: 'reply', status: 'waiting_input' }, { id: 'error', status: 'failed' },
  { id: 'run', status: 'running' }, { id: 'queue', status: 'queued' },
  { id: 'done', status: 'done' }, { id: 'stop', status: 'cancelled' },
];
assert.deepEqual(select('attention', tasks), ['reply', 'error']);
assert.deepEqual(select('active', tasks), ['run', 'queue']);
assert.deepEqual(select('history', tasks), ['done', 'stop']);
assert.equal(select('all', [...tasks, { id: 'future', status: 'future-status' }]).length, 7);
const missions = [
  { id: 'confirm', status: 'awaiting_confirmation' }, { id: 'restart', status: 'interrupted' },
  { id: 'conflict', status: 'needs_input' }, { id: 'error', status: 'failed' },
  { id: 'plan', status: 'planning' }, { id: 'review', status: 'reviewing' },
  { id: 'done', status: 'completed' }, { id: 'partial', status: 'partially_succeeded' },
];
assert.deepEqual(select('attention', missions, true), ['confirm', 'restart', 'conflict', 'error']);
assert.deepEqual(select('active', missions, true), ['plan', 'review']);
assert.deepEqual(select('history', missions, true), ['done', 'partial']);

const keyboardStart = source.indexOf("  composer.querySelector('#c-text').onkeydown = event => {");
const keyboardEnd = source.indexOf('\n  };', keyboardStart) + '\n  };'.length;
assert.ok(keyboardStart >= 0 && keyboardEnd > keyboardStart);
const field = { value: '中文草稿' };
const sends = [];
const captures = [];
Object.assign(context, {
  composer: { querySelector: () => field },
  targetPetId: 'supervisor',
  mode: false,
  submitComposer: (petId, mode) => sends.push({ petId, mode }),
  window: { petOffice: { startCapture: petId => captures.push(petId) } },
});
vm.runInContext(source.slice(keyboardStart, keyboardEnd), context);
let prevented = 0;
const enter = extra => field.onkeydown({ key: 'Enter', preventDefault: () => prevented++, ...extra });
enter({ isComposing: true });
enter({ keyCode: 229 });
enter({ shiftKey: true });
assert.equal(sends.length, 0);
assert.equal(prevented, 0, 'IME selection and Shift+Enter must remain native');
enter({});
assert.deepEqual(sends, [{ petId: 'supervisor', mode: false }]);
field.value = '/截图';
enter({});
assert.deepEqual(captures, ['supervisor']);
assert.equal(sends.length, 1, 'screenshot command must not also send a chat');
assert.equal(field.value, '');
console.log('workspace UI: status filters, IME composition, Shift+Enter, send and screenshot command passed');
