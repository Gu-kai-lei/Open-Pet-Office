'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MissionStore } = require('../src/mission-store');
const { MissionWorkspace, changedFiles, matchesScope } = require('../src/mission-workspace');
const { MissionManager, validatePlan, normalizeWorkerReport, WORKER_SCHEMA } = require('../src/mission-manager');
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

function rawPlan() {
  return {
    objective: '完成两阶段变更', assumptions: [],
    tasks: [
      { id: 'analysis', title: '分析', brief: '分析项目', assigneePetId: 'w1', fallbackAssignee: 'w2', fallbackModel: null, dependsOn: [], mode: 'write', fileScopes: ['a.txt'], deliverables: ['a.txt'], validation: [], required: true },
      { id: 'verify', title: '核验', brief: '核验并补充', assigneePetId: 'w2', fallbackAssignee: 'w1', fallbackModel: null, dependsOn: ['analysis'], mode: 'write', fileScopes: ['b.txt'], deliverables: ['b.txt'], validation: [], required: true },
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
const planner = {
  async planMission(options) { planThreadIds.push(options.threadId); return { ok: true, value: rawPlan(), threadId: 'supervisor-thread-' + planThreadIds.length }; },
  async reviewWave({ tasks }) { return { ok: true, threadId: 'supervisor-thread', value: { summary: '通过', decisions: tasks.map(task => task.id === 'analysis' && task.attempts === 1
    ? { taskId: task.id, decision: 'retry', reason: '先验证一次自动重试', nextBrief: '重试分析任务', nextAssignee: null, nextModel: null }
    : { taskId: task.id.toUpperCase(), decision: task.status === 'succeeded' ? 'accept' : 'fail', reason: '测试通过', nextBrief: null, nextAssignee: null, nextModel: null }) } }; },
  async finalReview() { return { ok: true, threadId: 'supervisor-thread', value: { verdict: 'pass', summary: '全部完成', validationSummary: '测试通过', risks: [] } }; },
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
  assert(manager.confirm(replanned.mission.id).ok);
  const limit = Date.now() + 6000;
  while (Date.now() < limit && !['completed', 'failed', 'needs_input'].includes(manager.get(draft.mission.id).status)) await new Promise(resolve => setTimeout(resolve, 20));
  const result = manager.get(draft.mission.id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(manager.threadOwner(result.supervisorThreadId).locked, false, 'finished Mission supervisor threads may be opened');
  assert.equal(result.tasks.find(task => task.id === 'analysis').attempts, 2);
  assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(fs.readFileSync(path.join(project, 'b.txt'), 'utf8'), 'b.txt\n');
  console.log('mission tests passed');
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
