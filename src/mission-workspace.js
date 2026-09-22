'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { workspacePath } = require('./path-safety');

const SKIP_DIRS = new Set(['.git', '.pet-office', 'node_modules', 'dist', 'build', '.cache', '.next', 'coverage']);

function runGit(cwd, args) {
  const result = spawnSync('git.exe', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  return { ok: result.status === 0, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally { fs.closeSync(handle); }
  return hash.digest('hex');
}

function walk(root, current = root, output = {}) {
  let entries = [];
  try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) walk(root, full, output);
    else if (entry.isFile()) {
      try {
        const stat = fs.statSync(full);
        output[rel] = { hash: hashFile(full), size: stat.size };
      } catch {}
    }
  }
  return output;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function changedFiles(before, after) {
  const paths = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const rel of [...paths].sort()) {
    const a = before && before[rel];
    const b = after && after[rel];
    if (!a && b) changes.push({ path: rel, kind: 'added', hash: b.hash, size: b.size });
    else if (a && !b) changes.push({ path: rel, kind: 'deleted', hash: a.hash, size: a.size });
    else if (a.hash !== b.hash) changes.push({ path: rel, kind: 'modified', beforeHash: a.hash, hash: b.hash, size: b.size });
  }
  return changes;
}

function safeRel(rel) {
  const normalized = path.normalize(String(rel || '')).replace(/^([/\\])+/, '');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('不安全的相对路径: ' + rel);
  return normalized;
}

function matchesScope(rel, scope) {
  const value = String(rel || '').replace(/\\/g, '/');
  const rule = String(scope || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rule) return false;
  if (!/[?*]/.test(rule)) return value === rule || value.startsWith(rule.replace(/\/$/, '') + '/');
  let pattern = '';
  for (let i = 0; i < rule.length; i++) {
    const char = rule[i];
    if (char === '*' && rule[i + 1] === '*') {
      if (rule[i + 2] === '/') { pattern += '(?:.*/)?'; i += 2; }
      else { pattern += '.*'; i += 1; }
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += /[.+^${}()|[\]\\]/.test(char) ? '\\' + char : char;
  }
  return new RegExp('^' + pattern + '$', 'i').test(value);
}

class MissionWorkspace {
  constructor({ runtimeRoot, log = () => {} }) {
    this.runtimeRoot = runtimeRoot;
    this.log = log;
  }

  inspect(projectPath) {
    const top = runGit(projectPath, ['rev-parse', '--show-toplevel']);
    const isGit = top.ok && path.resolve(top.stdout) === path.resolve(projectPath);
    const status = isGit ? runGit(projectPath, ['status', '--porcelain=v1', '--untracked-files=all']) : { ok: false, stdout: '' };
    const relevantStatus = String(status.stdout || '').split(/\r?\n/).filter(line => {
      const file = line.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/');
      return file && file !== '.pet-office' && !file.startsWith('.pet-office/');
    }).join('\n');
    const head = isGit ? runGit(projectPath, ['rev-parse', 'HEAD']) : { stdout: null };
    return {
      kind: isGit && !relevantStatus ? 'git-worktree' : (isGit ? 'git-snapshot' : 'snapshot'),
      isGit,
      clean: isGit && !relevantStatus,
      head: head.stdout || null,
      manifest: walk(projectPath),
      createdAt: Date.now(),
    };
  }

  prepareMission(mission) {
    const runtime = path.join(this.runtimeRoot, mission.id);
    fs.mkdirSync(runtime, { recursive: true });
    mission.baseline = this.inspect(mission.projectPath);
    mission.runtimeDir = runtime;
    const integration = path.join(runtime, 'integration');
    if (mission.baseline.kind === 'git-worktree') {
      const branch = 'pet-office/' + mission.id + '/integration';
      const added = runGit(mission.projectPath, ['worktree', 'add', '-b', branch, integration, mission.baseline.head]);
      if (!added.ok) throw new Error('无法创建集成 worktree: ' + added.stderr);
      mission.integrationBranch = branch;
    } else {
      copyTree(mission.projectPath, integration);
    }
    mission.integrationDir = integration;
    mission.integrationManifest = walk(integration);
    return mission.baseline;
  }

  prepareTask(mission, task) {
    const dir = path.join(mission.runtimeDir, 'workers', task.id + '-a' + (task.attempts || 1));
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (mission.baseline.kind === 'git-worktree') {
      const head = runGit(mission.integrationDir, ['rev-parse', 'HEAD']);
      const branch = 'pet-office/' + mission.id + '/' + task.id + '-a' + (task.attempts || 1);
      const added = runGit(mission.projectPath, ['worktree', 'add', '-b', branch, dir, head.stdout]);
      if (!added.ok) throw new Error('无法创建工作者 worktree: ' + added.stderr);
      task.workspaceBranch = branch;
    } else {
      copyTree(mission.integrationDir, dir);
    }
    task.workspace = dir;
    task.workspaceBaseline = walk(dir);
    return dir;
  }

  collect(mission, task, artifactDir) {
    const after = walk(task.workspace);
    const changes = changedFiles(task.workspaceBaseline || {}, after);
    const filesDir = path.join(artifactDir, 'files');
    for (const change of changes) {
      if (change.kind === 'deleted') continue;
      const rel = safeRel(change.path);
      const target = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(task.workspace, rel), target);
    }
    return { changes, filesDir };
  }

  applyAccepted(mission, acceptedTasks) {
    const claimed = new Map();
    const conflicts = [];
    for (const task of acceptedTasks) {
      for (const change of (task.changeSet && task.changeSet.changes) || []) {
        const previous = claimed.get(change.path);
        if (previous && previous.hash !== change.hash) conflicts.push({ path: change.path, taskIds: [previous.taskId, task.id] });
        else claimed.set(change.path, { taskId: task.id, hash: change.hash, kind: change.kind });
      }
    }
    if (conflicts.length) return { ok: false, conflicts };
    for (const task of acceptedTasks) this.applyChangeSet(mission.integrationDir, task.changeSet);
    if (mission.baseline.kind === 'git-worktree' && acceptedTasks.length) {
      runGit(mission.integrationDir, ['add', '-A']);
      const committed = runGit(mission.integrationDir, ['-c', 'user.name=Pet Office', '-c', 'user.email=pet-office@local', 'commit', '-m', 'Pet Office ' + mission.id + ' accepted wave']);
      if (!committed.ok && !/nothing to commit/i.test(committed.stdout + committed.stderr)) return { ok: false, conflicts: [{ path: '(git)', reason: committed.stderr }] };
    }
    return { ok: true };
  }

  applyChangeSet(targetRoot, changeSet) {
    for (const change of (changeSet && changeSet.changes) || []) {
      const rel = safeRel(change.path);
      const target = workspacePath(targetRoot, rel);
      if (change.kind === 'deleted') {
        if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(changeSet.filesDir, rel), target);
      }
    }
  }

  finalChangeSet(mission, artifactDir) {
    const after = walk(mission.integrationDir);
    const changes = changedFiles(mission.integrationManifest || {}, after);
    const filesDir = path.join(artifactDir, 'final-files');
    for (const change of changes) {
      if (change.kind === 'deleted') continue;
      const rel = safeRel(change.path);
      const target = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(mission.integrationDir, rel), target);
    }
    return { changes, filesDir };
  }

  preflightMain(mission, changeSet) {
    const current = this.inspect(mission.projectPath);
    const changedSinceStart = changedFiles(mission.baseline.manifest || {}, current.manifest || {});
    if (changedSinceStart.length) return { ok: false, kind: 'baseline_changed', conflicts: changedSinceStart.slice(0, 100) };
    const deletes = changeSet.changes.filter(change => change.kind === 'deleted');
    const binaries = changeSet.changes.filter(change => change.size > 2 * 1024 * 1024);
    const scopes = (mission.tasks || []).filter(task => task.status === 'accepted' && task.mode === 'write').flatMap(task => task.fileScopes || []);
    const outOfScope = changeSet.changes.filter(change => !scopes.some(scope => matchesScope(change.path, scope)));
    return { ok: true, highRisk: deletes.length > 0 || binaries.length > 3 || outOfScope.length > 0, deletes, binaries, outOfScope };
  }

  applyFinal(mission, changeSet) {
    const backup = path.join(mission.runtimeDir, 'backup-before-apply');
    copyTree(mission.projectPath, backup);
    this.applyChangeSet(mission.projectPath, changeSet);
    return { ok: true, backup };
  }

  cleanupSuccessful(mission) {
    const workersRoot = path.join(mission.runtimeDir, 'workers');
    for (const task of mission.tasks || []) {
      if (!task.workspace || !path.resolve(task.workspace).startsWith(path.resolve(workersRoot) + path.sep)) continue;
      if (mission.baseline.kind === 'git-worktree') {
        runGit(mission.projectPath, ['worktree', 'remove', '--force', task.workspace]);
        if (task.workspaceBranch) runGit(mission.projectPath, ['branch', '-D', task.workspaceBranch]);
      } else {
        try { fs.rmSync(task.workspace, { recursive: true, force: true }); } catch {}
      }
    }
    if (mission.integrationDir && path.resolve(mission.integrationDir).startsWith(path.resolve(mission.runtimeDir) + path.sep)) {
      if (mission.baseline.kind === 'git-worktree') {
        runGit(mission.projectPath, ['worktree', 'remove', '--force', mission.integrationDir]);
        if (mission.integrationBranch) runGit(mission.projectPath, ['branch', '-D', mission.integrationBranch]);
      } else {
        try { fs.rmSync(mission.integrationDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
}

module.exports = { MissionWorkspace, runGit, walk, copyTree, changedFiles, safeRel, matchesScope, SKIP_DIRS };
