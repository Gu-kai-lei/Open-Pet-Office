'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const code = source.slice(source.indexOf('async function startPetChat('), source.indexOf('async function cancelPetChat('));

function fixture(saved = true) {
  const calls = [];
  const project = { id: 'p1', path: process.cwd(), name: 'test' };
  const context = {
    state: { projects: [project], caps: {} },
    activeProject: () => project,
    petRoster: () => [{ id: 'supervisor', name: 'test', model: 'test-model' }],
    petSessionTokens: new Map(),
    dispatcher: { ensureProjectDirs() {} },
    petThreads: new Map(saved ? [['p1:supervisor', 'saved-thread']] : []),
    loadedThreads: new Set(), startingChats: new Set(), liveChats: new Map(),
    appServerIdleTimer: null, clearTimeout() {}, scheduleAppServerIdleStop() {},
    appServer: {
      resumeThread: async () => { calls.push('resume'); },
      startThread: async () => { calls.push('create'); return { threadId: 'new-thread' }; },
      setThreadName: async () => { calls.push('name'); },
      startTurn: async () => { calls.push('turn'); return { turnId: 'turn' }; },
      unsubscribeThread: async () => { calls.push('unsubscribe'); },
    },
    cfg: { saveState() {}, log() {} }, persistStandaloneTask() {}, send() {}, finishChat() {},
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, calls, run: () => context.startPetChat({ taskText: 'hello', projectId: 'p1', petId: 'supervisor' }) };
}

(async () => {
  const restored = fixture();
  assert.equal((await restored.run()).threadId, 'saved-thread');
  assert.deepEqual(restored.calls, ['resume', 'turn']);
  assert.equal((await restored.run()).ok, false);
  const fresh = fixture(false);
  assert.equal((await fresh.run()).threadId, 'new-thread');
  assert.deepEqual(fresh.calls, ['create', 'name', 'turn']);
  assert.equal(fresh.context.state.conversations['p1:supervisor'], 'new-thread');
  const failed = fixture();
  failed.context.appServer.resumeThread = async () => { throw new Error('unavailable'); };
  assert.equal((await failed.run()).ok, false);
  assert.deepEqual(failed.calls, []);
  assert.equal(failed.context.startingChats.size, 0);
  const occupied = fixture();
  occupied.context.appServer.resumeThread = async () => { occupied.calls.push('resume'); throw new Error('thread saved-thread already has an active writer'); };
  const occupiedResult = await occupied.run();
  assert.equal(occupiedResult.ok, false);
  assert.equal(occupiedResult.code, 'THREAD_OWNED_BY_CODEX');
  assert.equal(occupiedResult.threadId, 'saved-thread');
  assert.deepEqual(occupied.calls, ['resume']);
  assert.equal(occupied.context.petThreads.get('p1:supervisor'), 'saved-thread');
  const racing = fixture(false);
  let release;
  racing.context.appServer.startThread = () => new Promise(resolve => { release = resolve; });
  const first = racing.run();
  assert.equal((await racing.run()).ok, false);
  release({ threadId: 'new-thread' });
  assert.equal((await first).ok, true);
  console.log('PASS: restore, persist, duplicate send, explicit ownership conflict, failed resume, concurrent creation');
})().catch(error => { console.error(error); process.exitCode = 1; });
