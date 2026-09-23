'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { MissionManager } = require('../src/mission-manager');
const { MissionStore } = require('../src/mission-store');
const { CodexSessionMonitor, _internals: { redact } } = require('../src/session-monitor');
const { ingestFilesAsync, ingestFiles } = require('../src/inbox');
const { clearProjectInbox } = require('../src/project-service');
const { normalizeDroppedLinks } = require('../src/link-utils');
const { _internals: { failureBackoffMs } } = require('../src/quota');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-reliability-'));
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const noop = () => {};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
function fixture(planner = {}) {
  const manager = new MissionManager({
    runtimeRoot: root, projects: () => [{ id: 'p', name: 'test', path: root }],
    roster: () => [{ id: 'w1', name: 'worker', model: 'allowed' }],
    supervisorModel: () => null, planner, dispatcher: { cancel: noop },
  });
  manager.store = { create: noop, save: noop, event: noop, message: noop, review: noop, missionDir: () => root };
  manager.supervisorRuntime = () => root;
  return manager;
}
function mission(id = 'm', tasks = []) {
  return { id, status: 'running', projectPath: root, participants: [{ petId: 'w1', model: 'allowed' }], tasks };
}
function clientFixture() {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = noop;
    child.stderr = new EventEmitter(); child.stderr.setEncoding = noop;
    child.stdin = new EventEmitter();
    child.stdin.end = noop;
    child.stdin.write = line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: message.id, result: {} }) + '\n'));
    };
    child.kill = noop; children.push(child); return child;
  };
  const context = { module: { exports: {} }, require: name => name === 'child_process' ? { spawn } : { log: noop },
    process: { platform: 'win32', env: {} }, setTimeout, clearTimeout };
  vm.runInNewContext(read('src/appserver.js'), context);
  return { client: new context.module.exports.AppServerClient(), children };
}

(async () => {
  await test('quota failures use bounded exponential backoff', async () => {
    assert.equal(failureBackoffMs(1), 30000);
    assert.equal(failureBackoffMs(2), 60000);
    assert.equal(failureBackoffMs(4), 240000);
    assert.equal(failureBackoffMs(20), 1800000);
  });
  await test('cancel during planning cannot restore confirmation', async () => {
    const d = deferred(); let signal;
    const m = fixture({ planMission: args => { signal = args.signal; return d.promise; } });
    const pending = m.createDraft({ taskText: 'test', projectId: 'p', participants: [{ petId: 'w1', use: true }] });
    const id = [...m.missions.keys()][0]; m.cancel(id);
    d.resolve({ ok: true, value: { tasks: [{ id: 'a', assigneePetId: 'w1', dependsOn: [], required: true }] } });
    assert.equal((await pending).ok, false);
    assert.equal(m.get(id).status, 'cancelled'); assert(signal.aborted);
  });
  for (const action of ['cancel', 'shutdown']) await test(action + ' during final review prevents apply', async () => {
    const d = deferred(); const m = fixture({ finalReview: () => d.promise }); let applied = 0;
    m.workspace = { finalChangeSet: () => ({ changes: [] }), preflightMain: () => ({ ok: true }),
      applyFinal: () => { applied++; return {}; }, cleanupSuccessful: noop };
    const value = mission(); m.missions.set(value.id, value);
    const pending = m.finishMission(value);
    if (action === 'cancel') m.cancel(value.id); else m.shutdown();
    d.resolve({ ok: true, value: { verdict: 'pass' } }); await pending;
    assert.equal(applied, 0);
    assert.equal(value.status, action === 'cancel' ? 'cancelled' : 'interrupted');
  });
  await test('cancel during wave review does not integrate or retry', async () => {
    const d = deferred(); const entered = deferred(); let applied = 0;
    const m = fixture({ reviewWave: () => { entered.resolve(); return d.promise; } });
    m.executeTask = async (_m, task) => { task.status = 'succeeded'; task.attempts = 1; };
    m.workspace = { applyAccepted: () => { applied++; return { ok: true }; } };
    const value = mission('wave', [{ id: 'a', status: 'ready', required: true }]); m.missions.set(value.id, value);
    const pending = m.executeAndReviewWave(value, value.tasks); await entered.promise;
    m.cancel(value.id);
    d.resolve({ ok: true, value: { decisions: [{ taskId: 'a', decision: 'accept' }] } }); await pending;
    assert.equal(applied, 0); assert.equal(value.status, 'cancelled');
    m.handleTaskEvent({ type: 'done', taskId: 'wave:a' });
    assert.equal(value.tasks[0].status, 'cancelled');
  });
  await test('required dependency failure propagates and prevents final apply', async () => {
    let reviewed = false; const m = fixture({ finalReview: async () => { reviewed = true; return { ok: true }; } });
    const executed = [];
    m.executeAndReviewWave = async (_m, tasks) => {
      for (const task of tasks) { executed.push(task.id); task.status = 'failed'; }
    };
    const value = mission('deps', [
      { id: 'a', wave: 0, status: 'blocked', dependsOn: [], required: true },
      { id: 'b', wave: 1, status: 'blocked', dependsOn: ['a'], required: true },
      { id: 'c', wave: 2, status: 'blocked', dependsOn: ['b'], required: true },
    ]);
    value.baseline = {}; value.integrationDir = root; await m.run(value);
    assert.deepEqual(executed, ['a']); assert.equal(value.status, 'failed'); assert.equal(reviewed, false);
  });
  await test('intentional optional skip still permits its dependent', async () => {
    const m = fixture(); const executed = []; m.finishMission = async () => {};
    m.executeAndReviewWave = async (_m, tasks) => { for (const t of tasks) { executed.push(t.id); t.status = 'accepted'; } };
    const value = mission('optional', [
      { id: 'a', wave: 0, status: 'skipped', dependsOn: [], required: false },
      { id: 'b', wave: 1, status: 'blocked', dependsOn: ['a'], required: true },
    ]);
    value.baseline = {}; value.integrationDir = root; await m.run(value);
    assert.deepEqual(executed, ['b']);
  });
  for (const proposed of ['unconfirmed', 'fallback']) await test('reassign model validation: ' + proposed, async () => {
    const m = fixture({ reviewWave: async ({ tasks }) => ({ ok: true, value: { decisions: tasks.map(t => ({
      taskId: t.id, decision: t.attempts === 1 ? 'reassign' : 'accept', nextAssignee: 'w1', nextModel: proposed,
    })) } }) });
    m.workspace = { applyAccepted: () => ({ ok: true }) };
    const models = []; m.executeTask = async (_m, t) => { models.push(t.model); t.attempts++; t.status = 'succeeded'; };
    const task = { id: 'a', model: 'allowed', attempts: 0, required: true };
    const value = mission('model', [task]); value.participants[0].fallbackModel = 'fallback';
    await m.executeAndReviewWave(value, [task]);
    assert.deepEqual(models, ['allowed', proposed === 'fallback' ? 'fallback' : 'allowed']);
  });
  await test('old App Server exit/data cannot affect replacement', async () => {
    const { client: c, children } = clientFixture(); await c.start(); c.stop(); await c.start();
    const replacement = c.child; let closed = 0; c.onEvent(e => { if (e.type === 'closed') closed++; });
    const pending = c.request('test', {}); const id = c.nextId - 1;
    children[0].emit('exit', 0);
    children[0].stdout.emit('data', JSON.stringify({ id, error: { message: 'obsolete' } }) + '\n');
    assert.equal(c.child, replacement); assert.equal(closed, 0); assert.equal(c.pending.size, 1);
    replacement.stdout.emit('data', JSON.stringify({ id, result: { ok: true } }) + '\n');
    assert.equal((await pending).ok, true); c.stop();
  });
  await test('old initialization rejection cannot clear new connection', async () => {
    const { client: c } = clientFixture();
    const old = c.start().catch(e => e); c.stop();
    await c.start(); await old;
    assert(c.child); assert(c.readyPromise); c.stop();
  });
  await test('concurrent same-name uploads are exclusive and preserve contents', async () => {
    const folder = path.join(root, 'uploads');
    for (const name of ['left', 'right', 'project']) fs.mkdirSync(path.join(folder, name), { recursive: true });
    for (const name of ['left', 'right']) fs.writeFileSync(path.join(folder, name, 'same.txt'), name);
    const original = fs.promises.copyFile; const gate = deferred(); let started = 0;
    fs.promises.copyFile = async (...args) => { if (++started === 2) gate.resolve(); await gate.promise; return original(...args); };
    let values;
    try {
      values = await Promise.all(['left', 'right'].map(name => ingestFilesAsync({
        paths: [path.join(folder, name, 'same.txt')], projectPath: path.join(folder, 'project'),
      })));
    } finally { fs.promises.copyFile = original; }
    assert(values.every(r => r.ok)); assert.notEqual(values[0].files[0].path, values[1].files[0].path);
    assert.equal(fs.readFileSync(values[0].files[0].path, 'utf8'), 'left');
    assert.equal(fs.readFileSync(values[1].files[0].path, 'utf8'), 'right');
  });
  await test('junction inbox rejects clear and upload without external mutation', async () => {
    const project = path.join(root, 'junction-project'); const outside = path.join(root, 'outside');
    fs.mkdirSync(project); fs.mkdirSync(outside);
    const marker = path.join(outside, 'keep.txt'); fs.writeFileSync(marker, 'keep');
    fs.symlinkSync(outside, path.join(project, 'inbox'), 'junction');
    assert.throws(() => clearProjectInbox(project), /junction|链接/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
    assert.equal((await ingestFilesAsync({ paths: [marker], projectPath: project })).ok, false);
    assert.equal(ingestFiles({ paths: [marker], projectPath: project }).ok, false);
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  });
  await test('ordinary command progress is redacted before persistence', async () => {
    const source = read('src/main.js'); const context = { safeProgressText: redact };
    vm.runInNewContext(source.slice(source.indexOf('function appServerItemProgress('), source.indexOf('function finishChat(')), context);
    const text = context.appServerItemProgress('item/started', { type: 'commandExecution',
      command: 'tool --token=FAKE_AUDIT_VALUE password=FAKE_PASSWORD' }).text;
    assert.doesNotMatch(text, /FAKE_AUDIT_VALUE|FAKE_PASSWORD/); assert.match(text, /隐藏/);
  });
  await test('malformed URL remains usable alongside other links', async () => {
    const links = normalizeDroppedLinks({ plain: 'https://example.com/%ZZ https://example.com/ok' });
    assert.equal(links.length, 2); assert.equal(links[0].url, 'https://example.com/%ZZ');
  });
  await test('cross-project attachments copy once and failed copy blocks send', async () => {
    const source = read('renderer/app.js'); let calls = 0; let fail = false;
    const context = {
      composerAttachments: [
        { name: 'a.txt', path: '/A/a.txt', relPath: 'inbox/a.txt', projectId: 'A' },
        { type: 'link', url: 'https://example.com', name: 'example' },
      ],
      window: { petOffice: { ingestFiles: async (paths, projectId) => {
        calls++; assert.equal(projectId, 'B');
        if (fail) return { ok: false, error: 'copy failed' };
        return { ok: true, files: [{ path: '/B/a-1.txt', relPath: 'inbox/a-1.txt', name: 'a-1.txt', projectId }] };
      } } },
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('async function prepareComposerAttachments('), source.indexOf('async function ensureQuickProject(')), context);
    const files = await context.prepareComposerAttachments('B');
    assert.equal(files[0].projectId, 'B'); assert.equal(files[0].relPath, 'inbox/a-1.txt');
    assert.equal(files[1].type, 'link'); assert.equal(calls, 1);
    await context.prepareComposerAttachments('B'); assert.equal(calls, 1);
    fail = true; context.composerAttachments.push({ name: 'b.txt', path: '/A/b.txt', projectId: 'A' });
    await assert.rejects(() => context.prepareComposerAttachments('B'), /copy failed/);
    assert.equal(context.composerAttachments[0].projectId, 'B');
    assert.equal(context.composerAttachments[2].projectId, 'A');
  });
  await test('scan timestamps alone do not publish snapshots; health changes do', async () => {
    let updates = 0; const monitor = new CodexSessionMonitor({ onChange: () => updates++ });
    monitor._emitIfChanged();
    monitor.healthState.lastScanAt++; monitor._emitIfChanged(); assert.equal(updates, 1);
    monitor.healthState.ok = false; monitor._emitIfChanged(); assert.equal(updates, 2);
  });
  await test('progress persistence is coalesced and cancelled tasks stay terminal', async () => {
    const m = fixture(); let saves = 0; m.store.save = () => saves++;
    const value = mission('progress', [{ id: 'a', status: 'running' }]); m.missions.set(value.id, value);
    for (let i = 0; i < 20; i++) m.handleTaskEvent({ taskId: 'progress:a', type: 'progress', text: 'step ' + i });
    assert.equal(saves, 0); await delay(180); assert.equal(saves, 1);
    m.handleTaskEvent({ taskId: 'progress:a', type: 'progress', text: 'last' });
    m.cancel(value.id); const afterCancel = saves;
    await delay(180); assert.equal(saves, afterCancel); assert.equal(value.status, 'cancelled');
  });
  await test('unchanged plans are not rewritten during progress saves', async () => {
    const store = new MissionStore({ runtimeRoot: path.join(root, 'store-runtime') });
    const value = { ...mission('store'), plan: { objective: 'test', tasks: [{ id: 'a', title: 'task', status: 'running' }] } };
    store.save(value); const file = path.join(store.missionDir(root, 'store'), 'plan.json');
    const oldTime = new Date('2001-01-01T00:00:00Z'); fs.utimesSync(file, oldTime, oldTime);
    value.updatedAt = Date.now(); value.plan.tasks[0].progress = 'new progress'; value.plan.tasks[0].status = 'reviewing'; store.save(value);
    assert.equal(fs.statSync(file).mtimeMs, oldTime.getTime());
    value.plan.objective = 'changed'; store.save(value);
    assert.notEqual(fs.statSync(file).mtimeMs, oldTime.getTime());
  });
  await test('planner abort settles request and kills its process tree', async () => {
    const spawned = [];
    const fakeSpawn = (command, args) => {
      const child = new EventEmitter(); child.pid = 42; child.kill = noop; child.unref = noop;
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      spawned.push({ command, args, child }); return child;
    };
    const context = { module: { exports: {} }, require: name => name === 'child_process' ? { spawn: fakeSpawn }
      : name === './config' ? { log: noop } : require(name),
    process: { platform: 'win32' }, setTimeout, clearTimeout, Buffer };
    vm.runInNewContext(read('src/planner.js'), context);
    const controller = new AbortController();
    const pending = context.module.exports.runStructured({
      projectDir: root, missionDir: path.join(root,'planner'), kind: 'test', prompt: 'synthetic',
      schema: {}, signal: controller.signal,
    });
    controller.abort();
    assert.equal((await pending).cancelled, true);
    assert.equal(spawned[1].command, 'taskkill.exe');
    assert(spawned[1].args.includes('/T'));
    spawned[0].child.emit('exit', 0);
  });
  await test('ordinary conversation completion is idempotent', async () => {
    const source = read('src/main.js'); let saves = 0;
    const chat = { threadId: 't', task: { id: 'task', petId: 'supervisor', tokens: 10 }, startedAt: Date.now(), output: '' };
    const context = { liveChats: new Map([['t', chat]]), pendingInteractions: new Map(), petSessionTokens: new Map(),
      clearTimeout, flushChatDelta: noop, systemNotify: noop, persistStandaloneTask: () => saves++, send: noop,
      releaseFinishedThread: noop };
    vm.runInNewContext(source.slice(source.indexOf('function finishChat('), source.indexOf('function releaseFinishedThread(')), context);
    context.finishChat(chat, 'completed'); context.finishChat(chat, 'interrupted');
    assert.equal(saves, 1); assert.equal(chat.task.status, 'done'); assert.equal(context.petSessionTokens.get('supervisor'), 10);
  });
  console.log('reliability: ' + count + ' scenarios passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const realRoot = fs.realpathSync(root);
  if (realRoot.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(realRoot).startsWith('pet-office-reliability-')) {
    fs.rmSync(realRoot, { recursive: true, force: true });
  }
});
