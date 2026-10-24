'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MissionWorkspace, walk } = require('../src/mission-workspace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-isolation-test-'));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

try {
  // A dirty CV-style repository: datasets and weights are ignored and must
  // never be copied into every worker sandbox.
  const repo = path.join(root, 'cv-repo');
  const git = args => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  fs.mkdirSync(repo);
  assert.equal(git(['init', '--quiet']).status, 0);
  git(['config', 'user.name', 'Isolation Test']);
  git(['config', 'user.email', 'isolation@test.local']);
  write(path.join(repo, '.gitignore'), 'datasets/\n*.pt\nruns/\n');
  write(path.join(repo, 'train.py'), 'print("train")\n');
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['commit', '--quiet', '-m', 'baseline']).status, 0);
  write(path.join(repo, 'train.py'), 'print("edited")\n');
  write(path.join(repo, 'notes.md'), 'untracked but visible\n');
  write(path.join(repo, 'datasets', 'images', 'a.jpg'), Buffer.alloc(4096, 1));
  write(path.join(repo, 'best.pt'), Buffer.alloc(4096, 2));
  write(path.join(repo, 'runs', 'exp1', 'results.csv'), 'map,0.5\n');
  write(path.join(repo, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');

  const workspace = new MissionWorkspace({ runtimeRoot: path.join(root, 'runtime') });
  const mission = { id: 'cv', projectPath: repo, tasks: [] };
  workspace.prepareMission(mission);
  assert.equal(mission.baseline.kind, 'git-snapshot');
  const integration = mission.integrationDir;
  for (const rel of ['train.py', 'notes.md', '.gitignore']) assert.ok(exists(integration, rel), rel + ' belongs to the visible project state');
  for (const rel of ['datasets', 'best.pt', 'runs', 'node_modules', '.git']) assert.ok(!exists(integration, rel), rel + ' must not be copied');
  assert.equal(fs.readFileSync(path.join(integration, 'train.py'), 'utf8'), 'print("edited")\n', 'snapshot keeps uncommitted edits');
  assert.deepEqual(Object.keys(mission.baseline.manifest).sort(), ['.gitignore', 'notes.md', 'train.py']);

  // Worker copies inherit the same rules because .gitignore travels with them.
  const task = { id: 'w', attempts: 1 };
  workspace.prepareTask(mission, task);
  write(path.join(task.workspace, 'runs', 'exp2', 'scratch.csv'), 'ignored output\n');
  write(path.join(task.workspace, 'report.md'), '# report\n');
  const changes = workspace.collect(mission, task, path.join(root, 'artifacts')).changes.map(change => change.path);
  assert.deepEqual(changes, ['report.md'], 'ignored worker output is not collected as a deliverable');

  // Non-Git projects honour a root .gitignore and the built-in skip list.
  const plain = path.join(root, 'plain');
  write(path.join(plain, 'main.c'), 'int main(void) { return 0; }\n');
  write(path.join(plain, '.gitignore'), 'data/\n');
  write(path.join(plain, 'data', 'big.bin'), Buffer.alloc(2048));
  write(path.join(plain, '__pycache__', 'm.pyc'), Buffer.alloc(16));
  assert.deepEqual(Object.keys(walk(plain)).sort(), ['.gitignore', 'main.c']);
  assert.ok(!fs.existsSync(path.join(plain, '.git')), 'enumeration never writes git metadata into the project');

  // Projects that are still too large fail fast with an actionable message.
  const crowded = path.join(root, 'crowded');
  for (let index = 0; index < 6; index++) write(path.join(crowded, 'f' + index + '.txt'), String(index));
  const small = new MissionWorkspace({ runtimeRoot: path.join(root, 'runtime-small'), limits: { maxFiles: 3 } });
  assert.throws(() => small.prepareMission({ id: 'crowded', projectPath: crowded, tasks: [] }), error => error.code === 'PROJECT_TOO_LARGE' && /\.gitignore/.test(error.message));

  // Applying back to the project backs up only the files it replaces.
  const target = path.join(root, 'target');
  write(path.join(target, 'a.txt'), 'before\n');
  write(path.join(target, 'untouched.bin'), Buffer.alloc(8192, 3));
  const applyMission = { id: 'apply', projectPath: target, runtimeDir: path.join(root, 'runtime', 'apply') };
  fs.mkdirSync(applyMission.runtimeDir, { recursive: true });
  const filesDir = path.join(root, 'apply-files');
  write(path.join(filesDir, 'a.txt'), 'after\n');
  write(path.join(filesDir, 'new.txt'), 'new\n');
  const result = workspace.applyFinal(applyMission, { filesDir, changes: [
    { path: 'a.txt', kind: 'modified', hash: digest(path.join(filesDir, 'a.txt')) },
    { path: 'new.txt', kind: 'added', hash: digest(path.join(filesDir, 'new.txt')) },
  ] });
  assert.deepEqual(fs.readdirSync(result.backup), ['a.txt']);
  assert.equal(fs.readFileSync(path.join(result.backup, 'a.txt'), 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'after\n');

  // The hash cache must notice a same-size rewrite before baseline checks rely on it.
  const cached = path.join(root, 'cached');
  write(path.join(cached, 'same.txt'), 'aaaa');
  const first = walk(cached)['same.txt'].hash;
  fs.writeFileSync(path.join(cached, 'same.txt'), 'bbbb');
  assert.notEqual(walk(cached)['same.txt'].hash, first);

  console.log('isolation: gitignore-aware snapshots, worker collection, size limits, targeted backup and hash cache OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
