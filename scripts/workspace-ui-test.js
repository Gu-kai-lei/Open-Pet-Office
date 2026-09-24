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

// Drop guard contract: a Windows OLE drag ends with a synthesized mouse
// sequence; it must not close the composer or reset attachments.
assert.ok(source.includes('let dropGuardUntil = 0;'), 'drop guard state must exist');
const guardArms = source.split('dropGuardUntil = Date.now() + 800;').length - 1;
assert.equal(guardArms, 2, 'dragover and drop must both arm the guard');
assert.ok(source.includes('if (target) target.suppressClickUntil = dropGuardUntil;'), 'drag hover must suppress the hovered pet click handler');
assert.ok(source.includes('dropGuardUntil = Date.now() + 800;'), 'drop handler must arm the guard');
assert.ok(source.includes('target.suppressClickUntil = dropGuardUntil;'), 'drop must suppress the pet click handler');
assert.ok(source.includes('if (Date.now() < dropGuardUntil) return;'), 'stage pointerdown must honor the guard');
assert.ok(source.includes('floatingComposer'), 'composer-only state must keep the desktop click-through');
assert.ok(source.includes('modalOverlay = overlayIsOpen() && !floatingComposer'), 'modal surfaces must still capture the window');
const dragGuardWindow = source.slice(source.indexOf('function beginPetDrag'), source.indexOf('function updatePetDrag'));
assert.ok(dragGuardWindow.includes('if (Date.now() < dropGuardUntil) return;'), 'drop guard must block the synthesized pointerdown from starting a pet drag');
assert.ok(source.includes('data-activity-mission='), 'waiting Mission rows must expose a direct handling action');
assert.ok(source.includes('data-mission-regenerate='), 'failed planning rows must expose a direct replan action');
assert.ok(source.includes("showMissionPlan(result.mission, result.mission.objective"), 'successful replanning must reopen the confirmation surface');
assert.ok(source.includes("const ACTIVE_MISSION_STATUSES = new Set"), 'Mission ownership states must be explicit');
assert.ok(source.includes("mission.supervisorThreadId && !active"), 'active supervisor threads must not expose a Codex open button');
assert.ok(source.includes("openMissionDetails(missionId)"), 'live Mission cards must open their in-app record');
assert.ok(source.includes("result.code === 'ACTIVE_MISSION'"), 'stale Mission thread links must fall back to in-app records');
assert.ok(source.includes('Mission 结束前由 Pet Office 持有主管任务'), 'the UI must explain Mission thread ownership');
console.log('workspace UI: status filters, Mission handling, IME composition, drop guard, send and screenshot command passed');
