'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const code = source.slice(source.indexOf('async function startPetChat('), source.indexOf('function conversationKey('));

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
      interruptTurn: async () => { calls.push('interrupt'); },
    },
    cfg: { saveState() {}, log() {} }, persistStandaloneTask() {}, send() {}, finishChat() {},
  };
  context.chatForTask = id => [...context.liveChats.values()].find(chat => chat.task.id === id);
  context.finishChat = chat => { context.liveChats.delete(chat.threadId); };
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
  const archivedOnResume = fixture();
  archivedOnResume.context.appServer.resumeThread = async () => { archivedOnResume.calls.push('resume'); throw new Error('session saved-thread is archived. Run `codex unarchive saved-thread` to unarchive it first.'); };
  const archivedResumeResult = await archivedOnResume.run();
  assert.equal(archivedResumeResult.ok, true);
  assert.equal(archivedResumeResult.threadId, 'new-thread');
  assert.deepEqual(archivedOnResume.calls, ['resume', 'unsubscribe', 'create', 'name', 'turn']);
  assert.equal(archivedOnResume.context.petThreads.get('p1:supervisor'), 'new-thread');
  const archivedOnTurn = fixture();
  let oldTurn = true;
  archivedOnTurn.context.appServer.startTurn = async ({ threadId }) => {
    archivedOnTurn.calls.push('turn:' + threadId);
    if (oldTurn) { oldTurn = false; throw new Error('session saved-thread is archived'); }
    return { turnId: 'turn' };
  };
  const archivedTurnResult = await archivedOnTurn.run();
  assert.equal(archivedTurnResult.ok, true);
  assert.equal(archivedTurnResult.threadId, 'new-thread');
  assert.deepEqual(archivedOnTurn.calls, ['resume', 'turn:saved-thread', 'unsubscribe', 'create', 'name', 'turn:new-thread']);
  assert.equal(archivedOnTurn.context.liveChats.has('saved-thread'), false);
  assert.equal(archivedOnTurn.context.liveChats.has('new-thread'), true);
  const limited = fixture(false);
  limited.context.appServer.startTurn = async () => { throw new Error('exceeded retry limit, last status: 429 Too Many Requests'); };
  const limitedResult = await limited.run();
  assert.equal(limitedResult.ok, false);
  assert.equal(limitedResult.code, 'RATE_LIMITED');
  assert.match(limitedResult.error, /429/);
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
  const cancelling = fixture(false);
  let acknowledge;
  const entered = new Promise(resolve => {
    cancelling.context.appServer.startTurn = () => { resolve(); return new Promise(done => { acknowledge = done; }); };
  });
  const sending = cancelling.run();
  await entered;
  const current = [...cancelling.context.liveChats.values()][0];
  await cancelling.context.cancelPetChat(current.task.id);
  acknowledge({ turnId: 'late-turn' });
  assert.equal((await sending).ok, false);
  assert(cancelling.calls.includes('interrupt'));
  assert.equal(cancelling.context.liveChats.size, 0);
  console.log('PASS: restore, archived recovery, rate-limit handling, duplicate send, ownership conflict, concurrent creation');
})().catch(error => { console.error(error); process.exitCode = 1; });
