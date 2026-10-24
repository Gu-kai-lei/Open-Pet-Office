'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalCoordinator, _internals: { tokens, similarity, complexityOf } } = require('../src/local-coordinator');
const { MissionManager } = require('../src/mission-manager');
const { MissionStore } = require('../src/mission-store');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-local-engine-test-'));
const waitFor = async (predicate, ms = 6000) => {
  const limit = Date.now() + ms;
  while (Date.now() < limit && !predicate()) await new Promise(resolve => setTimeout(resolve, 20));
};

(async () => {
  // Keyword search works for mixed Chinese and English without any model download.
  assert.ok(tokens('先核验附件 then write report').has('核验'));
  assert.ok(tokens('先核验附件 then write report').has('report'));
  assert.equal(similarity(tokens('核验课程附件'), tokens('复杂文档任务先核对附件可访问性，再拆分写作')), 0, 'one shared word is noise');
  assert.ok(similarity(tokens('核验课程附件的可访问性'), tokens('复杂文档任务先核对附件可访问性，再拆分写作')) > 0.12);
  assert.ok(!tokens({ summary: 'x' }).has('summary'), 'object keys are not searchable text');
  assert.equal(similarity(tokens(''), tokens('anything')), 0);
  assert.equal(complexityOf('修个错别字'), 'low');
  assert.equal(complexityOf('重构调度器并处理并发恢复'), 'high');

  const coordinator = new LocalCoordinator({ root: path.join(root, 'memory') });
  assert.equal((await coordinator.health()).ready, true, 'the built-in engine never needs setup');
  assert.equal(coordinator.workerMcpConfig(), null, 'workers start without an extra MCP server');
  const projectA = coordinator.namespace('A');
  await coordinator.storeMemory('A', { key: 'k1', namespace: projectA, value: { result: '附件不可访问时先报告阻塞，再继续写作', token: 'sk-abcdefghijklmnop' } });
  await coordinator.storeMemory('A', { key: 'k1', namespace: projectA, value: { result: '附件不可访问时先报告阻塞，不要按标题推断原文' } });
  await coordinator.storeMemory('B', { key: 'k2', namespace: coordinator.namespace('B'), value: 'B 项目的私有经验：附件' });
  const stored = JSON.parse(fs.readFileSync(coordinator.memoryFile(projectA), 'utf8'));
  assert.equal(stored.length, 1, 'storeMemory upserts by key');
  assert.doesNotMatch(JSON.stringify(stored), /sk-abcdefghijklmnop/, 'secrets never reach memory files');
  const hits = await coordinator.searchMemory('A', { query: '课程附件无法访问怎么办', namespace: projectA, threshold: 0.7 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, 'k1');
  assert.equal((await coordinator.searchMemory('A', { query: 'B 项目的私有经验', namespace: projectA })).every(hit => hit.namespace === projectA), true, 'namespaces stay isolated');

  // Full Mission lifecycle on the default engine with no Ruflo adapter at all.
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'base.txt'), 'base\n');
  const participants = [{ petId: 'w1', name: '甲', model: null, use: true }, { petId: 'w2', name: '乙', model: null, use: true }];
  const plan = () => ({
    objective: '两阶段写入', assumptions: [],
    tasks: [
      { id: 'write-a', title: '写 A', brief: '写入 a.txt', role: 'coder', modelReason: '实现', assigneePetId: 'w1', fallbackAssignee: null, fallbackModel: null, dependsOn: [], mode: 'write', fileScopes: ['a.txt'], deliverables: ['a.txt'], validation: [], required: true },
      { id: 'write-b', title: '写 B', brief: '写入 b.txt', role: 'tester', modelReason: '核验', assigneePetId: 'w2', fallbackAssignee: null, fallbackModel: null, dependsOn: ['write-a'], mode: 'write', fileScopes: ['b.txt'], deliverables: ['b.txt'], validation: [], required: true },
    ],
  });
  const planner = {
    async planMission() { return { ok: true, value: plan(), threadId: 'local-supervisor' }; },
    async reviewWave({ tasks }) { return { ok: true, threadId: 'local-supervisor', value: { summary: 'ok', decisions: tasks.map(task => ({ taskId: task.id, decision: 'accept', reason: '已核验', nextBrief: null, nextAssignee: null, nextModel: null })) } }; },
    async finalReview() { return { ok: true, threadId: 'local-supervisor', value: { verdict: 'pass', summary: '附件核验与写入均完成', validationSummary: '读回一致', risks: [] } }; },
    presentFinal() { return Promise.resolve({ ok: true }); },
  };
  const started = [];
  let manager;
  const dispatcher = {
    startTask(task) {
      started.push(task);
      setImmediate(() => {
        const name = task.id.endsWith(':write-a') ? 'a.txt' : 'b.txt';
        fs.writeFileSync(path.join(task.projectDir, name), name + '\n');
        fs.writeFileSync(task.resultPath, JSON.stringify({ outcome: 'success', summary: name, changedFiles: [name], artifacts: [], validation: [], messages: [], blockers: [] }));
        manager.handleTaskEvent({ type: 'started', taskId: task.id });
        manager.handleTaskEvent({ type: 'done', taskId: task.id, elapsedMs: 1 });
      });
    },
    cancel() { return true; },
  };
  const runtimeRoot = path.join(root, 'runtime');
  manager = new MissionManager({
    runtimeRoot, projects: () => [{ id: 'p1', name: '本地项目', path: project }],
    roster: () => [{ id: 'supervisor', name: '主管', model: null }, { id: 'w1', name: '甲', model: null }, { id: 'w2', name: '乙', model: null }],
    supervisorModel: () => null, planner, dispatcher,
  });
  const draft = await manager.createDraft({ taskText: '两阶段写入', projectId: 'p1', participants });
  assert.ok(draft.ok, JSON.stringify(draft));
  assert.equal(draft.mission.engine, 'local');
  assert.equal(draft.mission.rufloVersion, null);
  assert.ok(draft.mission.tasks.every(task => task.rufloTaskId), 'every node gets a coordinator id');
  assert.ok(draft.mission.tasks.every(task => /^本地路由/.test(task.modelReason)), 'routing reasons name the engine that made them');
  assert.ok((await manager.confirm(draft.mission.id)).ok);
  await waitFor(() => ['completed', 'failed', 'needs_input'].includes(manager.get(draft.mission.id).status));
  const done = manager.get(draft.mission.id);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'a.txt\n');
  assert.equal(fs.readFileSync(path.join(project, 'b.txt'), 'utf8'), 'b.txt\n');
  assert.ok(started.every(task => task.rufloMcp === null), 'local Missions never inject a Ruflo MCP server into workers');
  assert.ok(started.every(task => task.brief.includes('# 协作信息') && !task.brief.includes('Ruflo')));
  assert.ok(fs.existsSync(path.join(runtimeRoot, '..', 'memory')), 'mission results are remembered locally');

  // Published patterns are visible to other projects; private memory is not.
  assert.ok((await manager.publishMemory(done.id)).ok);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const otherManager = new MissionManager({
    runtimeRoot, projects: () => [{ id: 'p2', name: '另一个项目', path: other }],
    roster: manager.roster, supervisorModel: () => null, planner, dispatcher: { cancel() {} }, local: manager.local,
  });
  const second = await otherManager.createDraft({ taskText: '附件核验与写入', projectId: 'p2', participants });
  assert.ok(second.ok);
  assert.ok(second.mission.memoryHits.some(hit => hit.source === 'published'));
  assert.ok(second.mission.memoryHits.every(hit => hit.namespace === 'pet-office-patterns'));
  await otherManager.cancel(second.mission.id);

  // Restarting keeps local Missions resumable instead of marking them legacy.
  const store = new MissionStore({ runtimeRoot });
  const waiting = { id: 'local-waiting', projectPath: project, projectId: 'p1', schemaVersion: 2, engine: 'local', status: 'awaiting_confirmation', tasks: [], createdAt: Date.now(), updatedAt: Date.now() };
  store.create(waiting);
  const reloaded = store.loadProjects([{ id: 'p1', name: 'P', path: project }]).find(item => item.id === waiting.id);
  assert.equal(reloaded.legacy, false);
  assert.equal(reloaded.status, 'awaiting_confirmation');

  // Choosing Ruflo without installing it fails with the setup code, not a crash.
  const rufloOnly = new MissionManager({
    runtimeRoot: path.join(root, 'runtime-ruflo'), projects: () => [{ id: 'p1', name: 'P', path: project }],
    roster: manager.roster, supervisorModel: () => null, planner, dispatcher, engine: () => 'ruflo',
    ruflo: { health: async () => ({ ready: false, state: 'setup_required', checks: {} }) },
  });
  const blocked = await rufloOnly.createDraft({ taskText: 'x', projectId: 'p1', participants });
  assert.equal(blocked.code, 'RUFLO_SETUP_REQUIRED');

  console.log('local engine: keyword memory, namespace isolation, full Mission without Ruflo and engine persistence OK');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
