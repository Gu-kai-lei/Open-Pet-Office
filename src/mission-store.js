'use strict';

const fs = require('fs');
const path = require('path');

const ACTIVE = new Set(['planning', 'awaiting_confirmation', 'running', 'reviewing', 'needs_input']);

function safeId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100);
}

function redact(value) {
  return String(value == null ? '' : value)
    .replace(/\b(sk-[a-zA-Z0-9_-]{8,})\b/g, '[REDACTED_KEY]')
    .replace(/(authorization|api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]');
}

function sanitizeValue(value, depth = 0) {
  if (depth > 12) return '[TRUNCATED]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = /^(authorization|api[_-]?key|access[_-]?token|secret|password)$/i.test(key) ? '[REDACTED]' : sanitizeValue(child, depth + 1);
    return output;
  }
  return value;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = file + '.next';
  fs.writeFileSync(next, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(next, file);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
}

class MissionStore {
  constructor({ runtimeRoot, log = () => {} }) {
    this.runtimeRoot = runtimeRoot;
    this.log = log;
    this.savedPlans = new Map();
  }

  projectRoot(projectPath) { return path.join(projectPath, '.pet-office'); }
  missionsRoot(projectPath) { return path.join(this.projectRoot(projectPath), 'missions'); }
  missionDir(projectPath, missionId) { return path.join(this.missionsRoot(projectPath), safeId(missionId)); }
  runtimeDir(missionId) { return path.join(this.runtimeRoot, safeId(missionId)); }

  ensureProject(projectPath) {
    const root = this.projectRoot(projectPath);
    fs.mkdirSync(path.join(root, 'missions'), { recursive: true });
    const memory = path.join(root, 'MEMORY.md');
    if (!fs.existsSync(memory)) fs.writeFileSync(memory, '# Pet Office Memory\n\n_主管确认后的共享结论记录在这里。_\n', 'utf8');
    return root;
  }

  create(mission) {
    const dir = this.missionDir(mission.projectPath, mission.id);
    this.ensureProject(mission.projectPath);
    for (const child of ['reviews', 'artifacts']) fs.mkdirSync(path.join(dir, child), { recursive: true });
    fs.mkdirSync(this.runtimeDir(mission.id), { recursive: true });
    this.save(mission);
    this.event(mission, 'mission.created', { status: mission.status });
    return mission;
  }

  save(mission) {
    mission.updatedAt = Date.now();
    const dir = this.missionDir(mission.projectPath, mission.id);
    const file = path.join(dir, 'mission.json');
    const backup = path.join(dir, 'mission.backup.json');
    try {
      if (fs.existsSync(file)) {
        JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.copyFileSync(file, backup);
      }
    } catch {}
    atomicJson(file, sanitizeValue(mission));
    if (mission.plan) {
      const plan = sanitizeValue({
        ...mission.plan,
        tasks: (mission.plan.tasks || []).map(task => Object.fromEntries([
          'id', 'title', 'brief', 'assigneePetId', 'assigneeName', 'model', 'fallbackAssignee', 'fallbackModel',
          'dependsOn', 'mode', 'fileScopes', 'deliverables', 'validation', 'required', 'wave',
        ].filter(key => Object.prototype.hasOwnProperty.call(task, key)).map(key => [key, task[key]]))),
      });
      const body = JSON.stringify(plan);
      if (this.savedPlans.get(file) !== body) {
        atomicJson(path.join(dir, 'plan.json'), plan);
        this.savedPlans.set(file, body);
      }
    }
    return mission;
  }

  event(mission, type, data = {}) {
    const event = { sequence: (mission.eventSequence = (mission.eventSequence || 0) + 1), type, at: Date.now(), data };
    appendJsonl(path.join(this.missionDir(mission.projectPath, mission.id), 'events.jsonl'), sanitizeValue(event));
    return event;
  }

  message(mission, message) {
    const value = {
      id: message.id || 'msg-' + Date.now().toString(36) + '-' + ((mission.messageSequence || 0) + 1),
      sequence: (mission.messageSequence = (mission.messageSequence || 0) + 1),
      missionId: mission.id,
      taskId: message.taskId || null,
      from: message.from || 'system',
      to: message.to || 'supervisor',
      type: message.type || 'status',
      summary: redact(message.summary).slice(0, 2000),
      artifactRefs: Array.isArray(message.artifactRefs) ? message.artifactRefs.map(redact).slice(0, 30) : [],
      createdAt: Date.now(),
    };
    appendJsonl(path.join(this.missionDir(mission.projectPath, mission.id), 'messages.jsonl'), value);
    return value;
  }

  review(mission, name, value) {
    atomicJson(path.join(this.missionDir(mission.projectPath, mission.id), 'reviews', safeId(name) + '.json'), sanitizeValue(value));
  }

  artifactPath(mission, ...parts) {
    const file = path.join(this.missionDir(mission.projectPath, mission.id), 'artifacts', ...parts.map(safeId));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  }

  load(projectPath, missionId) {
    const dir = this.missionDir(projectPath, missionId);
    for (const name of ['mission.json', 'mission.backup.json']) {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch {}
    }
    return null;
  }

  list(projectPath) {
    const root = this.missionsRoot(projectPath);
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => this.load(projectPath, entry.name))
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch { return []; }
  }

  loadProjects(projects) {
    const found = [];
    for (const project of projects || []) {
      for (const mission of this.list(project.path)) {
        mission.projectId = mission.projectId || project.id;
        mission.projectName = mission.projectName || project.name;
        mission.projectPath = mission.projectPath || project.path;
        if (ACTIVE.has(mission.status)) {
          mission.status = 'interrupted';
          mission.interruptionReason = 'Pet Office 已重启；运行进程未自动重连。';
          for (const task of mission.tasks || []) {
            if (['queued', 'running', 'reviewing'].includes(task.status)) task.status = 'interrupted';
          }
          this.event(mission, 'mission.interrupted', { reason: mission.interruptionReason });
          this.save(mission);
        }
        found.push(mission);
      }
    }
    return found;
  }
}

module.exports = { MissionStore, ACTIVE, atomicJson, appendJsonl, redact, sanitizeValue, safeId };
