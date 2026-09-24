'use strict';

// Opt-in live smoke test. It spends real model requests and therefore is not
// part of npm test. Usage: node scripts/mission-real-e2e.js <output-root>
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const planner = require('../src/planner');
const dispatcher = require('../src/dispatcher');
const { MissionManager } = require('../src/mission-manager');

const outputRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', '.e2e-mission'));
const supervisorModel = process.argv[3] || 'deepseek/deepseek-v4-flash';
const workerOneModel = process.argv[4] || 'gpt-5.6-sol';
const workerTwoModel = process.argv[5] || 'zhipu-bigmodel-coding/glm-5.3';
const runRoot = path.join(outputRoot, 'run-' + Date.now().toString(36));
const project = path.join(runRoot, 'project');
const runtime = path.join(runRoot, 'runtime');
const resultFile = path.join(runRoot, 'result.json');
fs.mkdirSync(project, { recursive: true });

function git(args) {
  const result = spawnSync('git.exe', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + String(result.stderr || result.stdout).trim());
}

git(['init']);
git(['config', 'user.name', 'Pet Office E2E']);
git(['config', 'user.email', 'pet-office-e2e@local']);
fs.writeFileSync(path.join(project, 'README.md'), '# Pet Office Mission E2E\n', 'utf8');
git(['add', 'README.md']);
git(['commit', '-m', 'baseline']);

let latest = null;
let manager;
const timeline = [];
manager = new MissionManager({
  runtimeRoot: runtime,
  projects: () => [{ id: 'e2e', name: 'Mission E2E', path: project }],
  roster: () => [
    { id: 'w1', name: 'Alpha Agent', model: workerOneModel },
    { id: 'w2', name: 'Beta Agent', model: workerTwoModel },
  ],
  supervisorModel: () => supervisorModel,
  planner,
  dispatcher,
  log: message => timeline.push({ at: Date.now(), log: String(message) }),
  onSnapshot: missions => {
    latest = missions[0] || latest;
    if (latest) timeline.push({ at: Date.now(), status: latest.status, tasks: latest.tasks.map(task => ({ id: task.id, status: task.status, error: task.error })) });
  },
});
dispatcher.setEmitter(event => manager.handleTaskEvent(event));
dispatcher.setConcurrency(2);

const objective = [
  '这是 Pet Office 分工链路验收。必须生成恰好两个无依赖、可并行、required=true 的写入任务，不要增加第三个任务。',
  '任务一必须分配给 w1，mode=write，只允许写 deliverables/alpha.txt，文件内容必须包含 ALPHA_OK。',
  '任务二必须分配给 w2，mode=write，只允许写 deliverables/beta.txt，文件内容必须包含 BETA_OK。',
  '两个工作者都要实际创建文件、读取核验内容，并在结构化报告中记录验证结果。主管阶段检查通过后执行最终复核并回写主项目。',
].join('\n');

function persist(extra = {}) {
  fs.writeFileSync(resultFile, JSON.stringify({ runRoot, project, latest, timeline, ...extra }, null, 2), 'utf8');
}

async function main() {
  const draft = await manager.createDraft({
    taskText: objective,
    projectId: 'e2e',
    participants: [
      { petId: 'w1', name: 'Alpha Agent', model: workerOneModel, use: true },
      { petId: 'w2', name: 'Beta Agent', model: workerTwoModel, use: true },
    ],
  });
  if (!draft.ok) throw new Error('planning failed: ' + draft.error);
  const assignees = new Set(draft.mission.tasks.map(task => task.assigneePetId));
  if (draft.mission.tasks.length !== 2 || !assignees.has('w1') || !assignees.has('w2')) {
    throw new Error('planner did not create the required two-agent plan: ' + JSON.stringify(draft.mission.tasks));
  }
  const confirmed = manager.confirm(draft.mission.id);
  if (!confirmed.ok) throw new Error('confirmation failed: ' + confirmed.error);
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = manager.get(draft.mission.id);
    latest = current;
    if (['completed', 'partially_succeeded', 'failed', 'needs_input', 'cancelled'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!latest || latest.status !== 'completed') throw new Error('Mission did not complete: ' + JSON.stringify(latest));
  const alpha = fs.readFileSync(path.join(project, 'deliverables', 'alpha.txt'), 'utf8');
  const beta = fs.readFileSync(path.join(project, 'deliverables', 'beta.txt'), 'utf8');
  if (!alpha.includes('ALPHA_OK') || !beta.includes('BETA_OK')) throw new Error('final files do not contain expected markers');
  persist({ ok: true, alpha, beta });
  console.log('MISSION_REAL_E2E_PASS ' + resultFile);
}

main().catch(error => {
  persist({ ok: false, error: error.stack || String(error) });
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  dispatcher.shutdown();
  planner.shutdown();
});
