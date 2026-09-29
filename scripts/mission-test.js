'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionStore } = require('../src/mission-store');
const { MissionWorkspace, changedFiles, matchesScope } = require('../src/mission-workspace');
const { MissionManager, validatePlan, normalizeWorkerReport, effectiveReviewDecision, WORKER_SCHEMA } = require('../src/mission-manager');
const { FakeRufloAdapter } = require('../src/ruflo-adapter');
const { parseStructuredOutput, recoverableSupervisorThreadError, PLAN_SCHEMA, REVIEW_SCHEMA, FINAL_SCHEMA, _internals: plannerInternals } = require('../src/planner');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-mission-test-'));
const project = path.join(root, 'project');
const runtime = path.join(root, 'runtime');
fs.mkdirSync(project, { recursive: true });
fs.writeFileSync(path.join(project, 'base.txt'), 'base\n');

function assertStrictSchema(schema, label) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object' && schema.additionalProperties === false) {
    assert.deepEqual([...(schema.required || [])].sort(), Object.keys(schema.properties || {}).sort(), label + ' must require every property');
  }
  for (const [key, value] of Object.entries(schema.properties || {})) assertStrictSchema(value, label + '.' + key);
  if (schema.items) assertStrictSchema(schema.items, label + '[]');
}

assertStrictSchema(PLAN_SCHEMA, 'PLAN_SCHEMA');
assertStrictSchema(REVIEW_SCHEMA, 'REVIEW_SCHEMA');
assertStrictSchema(FINAL_SCHEMA, 'FINAL_SCHEMA');
assertStrictSchema(WORKER_SCHEMA, 'WORKER_SCHEMA');
assert.equal(plannerInternals.errorFromEvent({ type: 'turn.failed', error: { message: 'schema rejected' } }), 'schema rejected');
assert.deepEqual(normalizeWorkerReport({
  file_path: 'deliverables/a.txt', written_content: 'A', validation_result: '通过', status: 'passed', reason: 'done',
}, {}).outcome, 'success');
assert.equal(effectiveReviewDecision({ status: 'succeeded', attempts: 1, report: { outcome: 'failed' } }, { decision: 'accept', reason: '模型误判' }).decision, 'retry');
assert.equal(effectiveReviewDecision({ status: 'succeeded', attempts: 2, report: { outcome: 'failed' } }, { decision: 'accept', reason: '模型误判' }).decision, 'fail');
assert.equal(effectiveReviewDecision({ status: 'succeeded', attempts: 1, report: { outcome: 'success' } }, null).decision, 'accept');

function rawPlan() {
  return {
    objective: '完成两阶段变更', assumptions: [],
    tasks: [
      { id: 'analysis', title: '分析', brief: '分析项目', role: 'coder', modelReason: '适合实现', assigneePetId: 'w1', fallbackAssignee: 'w2', fallbackModel: null, dependsOn: [], mode: 'write', fileScopes: ['a.txt'], deliverables: ['a.txt'], validation: [], required: true },
      { id: 'verify', title: '核验', brief: '核验并补充', role: 'tester', modelReason: '适合测试', assigneePetId: 'w2', fallbackAssignee: 'w1', fallbackModel: null, dependsOn: ['analysis'], mode: 'write', fileScopes: ['b.txt'], deliverables: ['b.txt'], validation: [], required: true },
    ],
  };
}

const participants = [{ petId: 'w1', name: '甲', model: null }, { petId: 'w2', name: '乙', model: null }];
const normalized = validatePlan(rawPlan(), participants);
assert.equal(normalized.tasks[0].wave, 0);
assert.equal(normalized.tasks[1].wave, 1);
const uppercaseDependencies = validatePlan({
  objective: '验证主管常用的大写任务编号', assumptions: [],
  tasks: [
    { id: 'T1', title: '输入一', brief: '读取资料一', assigneePetId: 'w1', dependsOn: [], mode: 'read', required: true },
    { id: 'T2', title: '输入二', brief: '读取资料二', assigneePetId: 'w2', dependsOn: [], mode: 'read', required: true },
    { id: 'T3', title: '处理一', brief: '处理资料一', assigneePetId: 'w1', dependsOn: ['T1'], mode: 'write', required: true },
    { id: 'T4', title: '处理二', brief: '处理资料二', assigneePetId: 'w2', dependsOn: ['t2'], mode: 'write', required: true },
    { id: 'T5', title: '整合', brief: '整合资料', assigneePetId: 'w1', dependsOn: ['T1', 'T2', 'T3', 'T4'], mode: 'write', required: true },
    { id: 'T6', title: '核验', brief: '交叉核验', assigneePetId: 'w2', dependsOn: ['t3', 't4'], mode: 'verify', required: true },
    { id: 'T7', title: '交付', brief: '最终交付', assigneePetId: 'w1', dependsOn: ['T5', 't6'], mode: 'write', required: true },
  ],
}, participants);
assert.deepEqual(uppercaseDependencies.tasks.map(task => task.id), ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
assert.deepEqual(uppercaseDependencies.tasks.map(task => task.dependsOn), [[], [], ['t1'], ['t2'], ['t1', 't2', 't3', 't4'], ['t3', 't4'], ['t5', 't6']]);
assert.deepEqual(uppercaseDependencies.tasks.map(task => task.wave), [0, 0, 1, 1, 2, 2, 3]);
const aliased = validatePlan({
  goal: '兼容第三方模型计划',
  tasks: [{
    id: 'alias', title: '别名任务', description: '保留完整任务说明', assigneePetId: 'w1',
    dependsOn: [], operation: 'write', fileScopes: ['deliverables/result.md'], required: true,
  }],
}, participants);
assert.equal(aliased.objective, '兼容第三方模型计划');
assert.equal(aliased.tasks[0].brief, '保留完整任务说明');
assert.equal(aliased.tasks[0].mode, 'write');
assert(aliased.tasks[0].deliverables.length);
assert(aliased.tasks[0].validation.length);
const cyclic = rawPlan();
cyclic.tasks[0].dependsOn = ['verify'];
assert.throws(() => validatePlan(cyclic, participants), /循环/);
assert(matchesScope('src/a.js', 'src/**/*'));
assert(matchesScope('a.txt', 'a.txt'));
assert(!matchesScope('b.txt', 'a.txt'));
assert.deepEqual(parseStructuredOutput('```json\n{"ok":true}\n```'), { ok: true });
assert.equal(recoverableSupervisorThreadError('thread-source conflict: thread already has an active writer'), true);
assert.equal(recoverableSupervisorThreadError('request timed out'), false);
assert.deepEqual(changedFiles({ 'a': { hash: '1', size: 1 } }, { 'a': { hash: '2', size: 1 }, 'b': { hash: '3', size: 1 } }).map(x => x.kind), ['modified', 'added']);

const store = new MissionStore({ runtimeRoot: runtime });
const saved = { id: 'recover', projectPath: project, projectId: 'p1', status: 'running', note: 'api_key=secret-value', tasks: [{ id: 't', status: 'running' }], createdAt: Date.now(), updatedAt: Date.now() };
store.create(saved);
store.save(saved);
assert(!fs.readFileSync(path.join(store.missionDir(project, saved.id), 'mission.json'), 'utf8').includes('secret-value'));
fs.writeFileSync(path.join(store.missionDir(project, saved.id), 'mission.json'), '{bad', 'utf8');
assert.equal(store.load(project, saved.id).id, 'recover');
const loaded = store.loadProjects([{ id: 'p1', name: 'P', path: project }]).find(item => item.id === 'recover');
assert.equal(loaded.status, 'interrupted');
assert.equal(loaded.tasks[0].status, 'interrupted');
const waiting = { id: 'waiting-confirmation', projectPath: project, projectId: 'p1', schemaVersion: 2, engine: 'ruflo', status: 'awaiting_confirmation', tasks: [{ id: 't', status: 'blocked', attempts: 0 }], createdAt: Date.now(), updatedAt: Date.now() };
store.create(waiting);
assert.equal(store.loadProjects([{ id: 'p1', name: 'P', path: project }]).find(item => item.id === waiting.id).status, 'awaiting_confirmation', 'restart must preserve the user confirmation gate');

const workspace = new MissionWorkspace({ runtimeRoot: runtime });
const probeMission = { id: 'probe', projectPath: project, tasks: [] };
workspace.prepareMission(probeMission);
const probeTask1 = { id: 'one', attempts: 1 };
const probeTask2 = { id: 'two', attempts: 1 };
workspace.prepareTask(probeMission, probeTask1);
workspace.prepareTask(probeMission, probeTask2);
fs.writeFileSync(path.join(probeTask1.workspace, 'same.txt'), 'one');
fs.writeFileSync(path.join(probeTask2.workspace, 'same.txt'), 'two');
probeTask1.changeSet = workspace.collect(probeMission, probeTask1, path.join(root, 'artifacts-1'));
probeTask2.changeSet = workspace.collect(probeMission, probeTask2, path.join(root, 'artifacts-2'));
assert.equal(workspace.applyAccepted(probeMission, [probeTask1, probeTask2]).ok, false);
const binaryProbe = { id: 'binary-probe', projectPath: project, tasks: [{ status: 'accepted', mode: 'write', fileScopes: ['image.bin'] }] };
workspace.prepareMission(binaryProbe);
const binarySet = { filesDir: path.join(root, 'binary-files'), changes: [{ path: 'image.bin', kind: 'added', size: 4 }] };
fs.mkdirSync(binarySet.filesDir, { recursive: true });
fs.writeFileSync(path.join(binarySet.filesDir, 'image.bin'), Buffer.from([1, 0, 2, 3]));
assert.equal(workspace.preflightMain(binaryProbe, binarySet).highRisk, true, 'one binary file needs explicit approval');

const gitProject = path.join(root, 'git-project');
fs.mkdirSync(gitProject, { recursive: true });
const git = args => spawnSync('git.exe', ['-C', gitProject, ...args], { encoding: 'utf8', windowsHide: true });
assert.equal(git(['init']).status, 0);
assert.equal(git(['config', 'user.name', 'Mission Test']).status, 0);
assert.equal(git(['config', 'user.email', 'mission@test.local']).status, 0);
fs.writeFileSync(path.join(gitProject, 'tracked.txt'), 'before\n');
assert.equal(git(['add', 'tracked.txt']).status, 0);
assert.equal(git(['commit', '-m', 'baseline']).status, 0);
fs.mkdirSync(path.join(gitProject, '.pet-office', 'missions'), { recursive: true });
const gitWorkspace = new MissionWorkspace({ runtimeRoot: path.join(root, 'git-runtime') });
const gitMission = { id: 'gitprobe', projectPath: gitProject, tasks: [] };
gitWorkspace.prepareMission(gitMission);
assert.equal(gitMission.baseline.kind, 'git-worktree');
const gitTask = { id: 'edit', attempts: 1, status: 'accepted', mode: 'write', fileScopes: ['tracked.txt'] };
gitMission.tasks.push(gitTask);
gitWorkspace.prepareTask(gitMission, gitTask);
fs.writeFileSync(path.join(gitTask.workspace, 'tracked.txt'), 'after\n');
gitTask.changeSet = gitWorkspace.collect(gitMission, gitTask, path.join(root, 'git-artifact'));
assert(gitWorkspace.applyAccepted(gitMission, [gitTask]).ok);
const gitFinal = gitWorkspace.finalChangeSet(gitMission, path.join(root, 'git-final'));
assert.equal(gitWorkspace.preflightMain(gitMission, gitFinal).highRisk, false);
gitWorkspace.applyFinal(gitMission, gitFinal);
assert.equal(fs.readFileSync(path.join(gitProject, 'tracked.txt'), 'utf8'), 'after\n');
gitWorkspace.cleanupSuccessful(gitMission);

let manager;
const planThreadIds = [];
const presentCalls = [];
const planner = {
  async planMission(options) { planThreadIds.push(options.threadId); return { ok: true, value: rawPlan(), threadId: 'supervisor-thread-' + planThreadIds.length }; },
  async reviewWave({ tasks }) { return { ok: true, threadId: 'supervisor-thread', value: { summary: '通过', decisions: tasks.map(task => task.id === 'analysis' && task.attempts === 1
    ? { taskId: task.id, decision: 'retry', reason: '先验证一次自动重试', nextBrief: '重试分析任务', nextAssignee: null, nextModel: null }
    : { taskId: task.id.toUpperCase(), decision: task.status === 'succeeded' ? 'accept' : 'fail', reason: '测试通过', nextBrief: null, nextAssignee: null, nextModel: null }) } }; },
  async finalReview() { return { ok: true, threadId: 'supervisor-thread', value: { verdict: 'pass', summary: '全部完成', validationSummary: '测试通过', risks: [] } }; },
  presentFinal(options) { presentCalls.push(options); return Promise.resolve({ ok: true }); },
};
const dispatcher = {
  startTask(task) {
    setImmediate(() => {
      manager.handleTaskEvent({ type: 'started', taskId: task.id });
      const name = task.id.endsWith(':analysis') ? 'a.txt' : 'b.txt';
      fs.writeFileSync(path.join(task.projectDir, name), name + '\n');
      fs.writeFileSync(task.resultPath, JSON.stringify({ outcome: 'success', summary: name + ' 完成', changedFiles: [name], artifacts: [], validation: [], messages: [], blockers: [] }));
      manager.handleTaskEvent({ type: 'session', taskId: task.id, threadId: task.id + '-thread' });
      manager.handleTaskEvent({ type: 'done', taskId: task.id, elapsedMs: 2 });
    });
  },
  cancel() { return true; },
};

manager = new MissionManager({
  runtimeRoot: path.join(root, 'manager-runtime'), projects: () => [{ id: 'p1', name: '测试项目', path: project }],
  roster: () => [{ id: 'supervisor', name: '主管', model: null }, { id: 'w1', name: '甲', model: null }, { id: 'w2', name: '乙', model: null }],
  supervisorModel: () => null, planner, dispatcher,
  ruflo: new FakeRufloAdapter(),
});

(async () => {
  const draft = await manager.createDraft({ taskText: '完成两阶段变更', projectId: 'p1', participants: participants.map(item => ({ ...item, use: true })) });
  assert(draft.ok);
  assert.equal(draft.mission.status, 'awaiting_confirmation');
  assert.deepEqual(manager.threadOwner(draft.mission.supervisorThreadId), {
    missionId: draft.mission.id, status: 'awaiting_confirmation', role: 'supervisor', locked: true,
  });
  const replanned = await manager.regenerate(draft.mission.id);
  assert(replanned.ok);
  assert.deepEqual(planThreadIds, [null, null], 'replanning must create a fresh supervisor thread');
  assert((await manager.confirm(replanned.mission.id)).ok);
  const limit = Date.now() + 6000;
  while (Date.now() < limit && !['completed', 'failed', 'needs_input'].includes(manager.get(draft.mission.id).status)) await new Promise(resolve => setTimeout(resolve, 20));
  const result = manager.get(draft.mission.id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(manager.threadOwner(result.supervisorThreadId).locked, false, 'finished Mission supervisor threads may be opened');
  assert.equal(result.tasks.find(task => task.id === 'analysis').attempts, 2);
  assert.equal(presentCalls.length, 1, 'final review must schedule one readable summary turn');
  assert.equal(presentCalls[0].review.verdict, 'pass');
  assert.equal(presentCalls[0].threadId, result.supervisorThreadId);
  assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(fs.readFileSync(path.join(project, 'b.txt'), 'utf8'), 'b.txt\n');
  assert(manager.artifactPath(result.id, 'a.txt') && fs.existsSync(manager.artifactPath(result.id, 'a.txt')));
  assert.equal(manager.artifactPath(result.id, '../base.txt'), null, 'artifact paths must not escape the Mission');
  assert((await manager.publishMemory(result.id)).ok);
  const otherProject = path.join(root, 'other-project');
  fs.mkdirSync(otherProject, { recursive: true });
  const otherManager = new MissionManager({
    runtimeRoot: path.join(root, 'other-runtime'), projects: () => [{ id: 'p2', name: '另一个项目', path: otherProject }],
    roster: manager.roster, supervisorModel: () => null, planner, dispatcher: { cancel() {} }, ruflo: manager.ruflo,
  });
  const crossProject = await otherManager.createDraft({ taskText: '跨项目经验隔离', projectId: 'p2', participants: participants.map(item => ({ ...item, use: true })) });
  assert(crossProject.ok);
  assert(crossProject.mission.memoryHits.some(hit => hit.source === 'published'), 'user-published patterns should be available in another project');
  assert(crossProject.mission.memoryHits.every(hit => hit.namespace === 'pet-office-patterns'), 'another project must not read private project memory');
  await otherManager.cancel(crossProject.mission.id);

  const originalUpdate = manager.ruflo.updateTask.bind(manager.ruflo);
  const stalled = await manager.createDraft({ taskText: '验证同步失败不会启动工作者', projectId: 'p1', participants: participants.map(item => ({ ...item, use: true })) });
  assert(stalled.ok);
  manager.ruflo.updateTask = async () => { throw new Error('MCP unavailable'); };
  const blocked = await manager.confirm(stalled.mission.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.mission.status, 'needs_input');
  assert(blocked.mission.tasks.every(task => !task.attempts), 'failed Ruflo confirmation must not execute workers');
  manager.ruflo.updateTask = originalUpdate;
  const restored = await manager.resume(stalled.mission.id);
  assert.equal(restored.mission.status, 'awaiting_confirmation', 'repair must return to the confirmation page');
  await manager.cancel(stalled.mission.id);

  const originalReview = planner.reviewWave;
  let failReview = true;
  planner.reviewWave = async ({ tasks }) => {
    if (failReview) { failReview = false; return { ok: false, error: 'temporary reviewer failure' }; }
    return { ok: true, value: { summary: '复核通过', decisions: tasks.map(task => ({ taskId: task.id, decision: 'accept', reason: '内容已核验' })) } };
  };
  const reviewDraft = await manager.createDraft({ taskText: '验证复核失败后只重试复核', projectId: 'p1', participants: participants.map(item => ({ ...item, use: true })) });
  assert(reviewDraft.ok);
  assert((await manager.confirm(reviewDraft.mission.id)).ok);
  const reviewLimit = Date.now() + 6000;
  while (Date.now() < reviewLimit && manager.get(reviewDraft.mission.id).status !== 'needs_input') await new Promise(resolve => setTimeout(resolve, 20));
  const waitingReview = manager.get(reviewDraft.mission.id);
  assert.equal(waitingReview.pendingAction.kind, 'review_failed');
  assert.equal(waitingReview.tasks[0].attempts, 1);
  assert((await manager.resume(reviewDraft.mission.id)).ok);
  while (Date.now() < reviewLimit && !['completed', 'failed', 'needs_input'].includes(manager.get(reviewDraft.mission.id).status)) await new Promise(resolve => setTimeout(resolve, 20));
  const reviewed = manager.get(reviewDraft.mission.id);
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.tasks[0].attempts, 1, 'review retry must not rerun a successful worker');
  planner.reviewWave = originalReview;

  const originalStartTask = dispatcher.startTask;
  dispatcher.startTask = task => setImmediate(() => {
    manager.handleTaskEvent({ type: 'started', taskId: task.id });
    fs.writeFileSync(task.resultPath, JSON.stringify({
      outcome: 'failed', summary: 'Windows sandbox 初始化失败', changedFiles: [], artifacts: [],
      validation: [], messages: [], blockers: ['helper_unknown_error: apply deny-read ACLs'],
    }));
    manager.handleTaskEvent({ type: 'done', taskId: task.id, elapsedMs: 2 });
  });
  const environmentDraft = await manager.createDraft({ taskText: '验证沙箱故障暂停自动重试', projectId: 'p1', participants: participants.map(item => ({ ...item, use: true })) });
  assert(environmentDraft.ok);
  assert((await manager.confirm(environmentDraft.mission.id)).ok);
  const environmentLimit = Date.now() + 6000;
  while (Date.now() < environmentLimit && manager.get(environmentDraft.mission.id).status !== 'needs_input') await new Promise(resolve => setTimeout(resolve, 20));
  const environmentPaused = manager.get(environmentDraft.mission.id);
  assert.equal(environmentPaused.pendingAction.kind, 'worker_environment');
  assert.equal(environmentPaused.tasks[0].attempts, 1, 'environment failure must not trigger an automatic second attempt');
  assert.equal(environmentPaused.tasks[1].attempts, 0, 'dependent work must remain unstarted');
  assert.equal((await manager.resume(environmentDraft.mission.id)).ok, false, 'replay requires an explicit choice');
  dispatcher.startTask = originalStartTask;
  assert((await manager.resume(environmentDraft.mission.id, true)).ok);
  while (Date.now() < environmentLimit && !['completed', 'failed', 'needs_input'].includes(manager.get(environmentDraft.mission.id).status)) await new Promise(resolve => setTimeout(resolve, 20));
  const environmentRecovered = manager.get(environmentDraft.mission.id);
  assert.equal(environmentRecovered.status, 'completed', JSON.stringify(environmentRecovered));
  assert.equal(environmentRecovered.tasks[0].attempts, 2, 'explicit replay should run only the failed node again');
  assert.equal(environmentRecovered.tasks[1].attempts, 1);

  const setupRecovery = {
    id: 'setup-recovery-test', schemaVersion: 2, engine: 'ruflo', legacy: false,
    projectId: 'p1', projectName: '测试项目', projectPath: project, objective: '恢复 Ruflo 初始化阶段',
    status: 'interrupted', interruptedFrom: 'setup', participants, tasks: [], plan: null,
    memoryNamespace: manager.ruflo.namespace('p1'), createdAt: Date.now(), updatedAt: Date.now(),
  };
  manager.missions.set(setupRecovery.id, setupRecovery);
  manager.store.create(setupRecovery);
  const setupResult = await manager.resume(setupRecovery.id);
  assert.equal(setupResult.mission.status, 'awaiting_confirmation');
  assert(setupResult.mission.swarmId && setupResult.mission.tasks.every(task => task.rufloTaskId), 'setup recovery must register a real Ruflo plan before confirmation');
  await manager.cancel(setupRecovery.id);

  const partialDraft = await manager.createDraft({ taskText: '验证只补注册丢失的任务', projectId: 'p1', participants: participants.map(item => ({ ...item, use: true })) });
  assert(partialDraft.ok);
  const partial = manager.missions.get(partialDraft.mission.id);
  const retainedTaskId = partial.tasks[0].rufloTaskId;
  const missingTaskId = partial.tasks[1].rufloTaskId;
  partial.status = 'interrupted'; partial.interruptedFrom = 'planning';
  manager.ruflo.tasks.delete(missingTaskId);
  const originalReconcile = manager.ruflo.reconcile.bind(manager.ruflo);
  manager.ruflo.reconcile = async () => ({ ok: false, differences: [{ kind: 'task_missing', taskId: partial.tasks[1].id, rufloTaskId: missingTaskId }] });
  const repairedPlan = await manager.resume(partial.id);
  manager.ruflo.reconcile = originalReconcile;
  assert.equal(repairedPlan.mission.status, 'awaiting_confirmation');
  assert.equal(repairedPlan.mission.tasks[0].rufloTaskId, retainedTaskId, 'an existing Ruflo task must not be created twice');
  assert.notEqual(repairedPlan.mission.tasks[1].rufloTaskId, missingTaskId, 'a missing unstarted task must be registered again');
  await manager.cancel(partial.id);
  console.log('mission tests passed');
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
