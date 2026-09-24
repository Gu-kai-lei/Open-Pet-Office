'use strict';

const fs = require('fs');
const path = require('path');
const { MissionStore, sanitizeValue } = require('./mission-store');
const { MissionWorkspace } = require('./mission-workspace');

const TERMINAL = new Set(['completed', 'partially_succeeded', 'failed', 'cancelled']);
const WORKER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'summary', 'changedFiles', 'artifacts', 'validation', 'messages', 'blockers'],
  properties: {
    outcome: { type: 'string', enum: ['success', 'partial', 'failed'] },
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'string' } },
    validation: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['command', 'status', 'summary'],
        properties: { command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, summary: { type: 'string' } },
      },
    },
    messages: {
      type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['to', 'type', 'summary'],
        properties: { to: { type: 'string' }, type: { type: 'string', enum: ['status', 'question', 'result', 'context'] }, summary: { type: 'string' } },
      },
    },
    blockers: { type: 'array', items: { type: 'string' } },
  },
};

function missionId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function taskId(value, index) {
  const base = String(value || 'task-' + (index + 1)).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 44);
  return base || 'task-' + (index + 1);
}

function taskReferenceAliases(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return [];
  const normalized = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 44);
  return [...new Set([raw, raw.toLowerCase(), normalized].filter(Boolean))];
}

function resolveTaskReference(value, aliases) {
  for (const alias of taskReferenceAliases(value)) {
    if (aliases.has(alias)) return aliases.get(alias);
  }
  return null;
}

function normalizeWorkerReport(raw, task) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const status = String(value.status || value.validation_result || '').toLowerCase();
  const outcome = ['success', 'partial', 'failed'].includes(value.outcome)
    ? value.outcome
    : (/pass|success|通过|完成/.test(status) ? 'success' : (/fail|block|失败|阻塞/.test(status) ? 'failed' : 'partial'));
  const summary = String(value.summary || value.reason || (
    value.file_path ? ('工作者已返回 ' + value.file_path + ' 的执行报告。') : '工作者已返回结构化报告。'
  ));
  const changedFiles = Array.isArray(value.changedFiles) ? value.changedFiles.map(String)
    : (value.file_path && value.written_content != null ? [String(value.file_path)] : []);
  const validation = Array.isArray(value.validation) ? value.validation.map(entry => ({
    command: String(entry && entry.command || '未记录命令'),
    status: ['passed', 'failed', 'not_run'].includes(entry && entry.status) ? entry.status : 'not_run',
    summary: String(entry && entry.summary || ''),
  })) : (value.validation_result ? [{
    command: '工作者读回核验',
    status: /pass|success|通过/.test(status) ? 'passed' : 'failed',
    summary: String(value.validation_result),
  }] : []);
  const messages = Array.isArray(value.messages) ? value.messages.map(entry => ({
    to: String(entry && entry.to || 'supervisor'),
    type: ['status', 'question', 'result', 'context'].includes(entry && entry.type) ? entry.type : 'result',
    summary: String(entry && entry.summary || ''),
  })) : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers.map(String)
    : (outcome === 'failed' && value.reason ? [String(value.reason)] : []);
  return { outcome, summary, changedFiles, artifacts: Array.isArray(value.artifacts) ? value.artifacts.map(String) : [], validation, messages, blockers };
}

function validatePlan(rawPlan, participants) {
  if (!rawPlan || !Array.isArray(rawPlan.tasks) || !rawPlan.tasks.length) throw new Error('主管没有生成有效任务节点。');
  const allowed = new Map(participants.map(item => [item.petId, item]));
  const ids = new Set();
  const descriptors = rawPlan.tasks.map((raw, index) => {
    const rawId = String(raw && raw.id || 'task-' + (index + 1)).trim();
    let id = taskId(rawId, index);
    while (ids.has(id)) id += '-' + (index + 1);
    ids.add(id);
    return { raw, index, rawId, id };
  });
  const referenceAliases = new Map();
  for (const descriptor of descriptors) {
    for (const alias of new Set([...taskReferenceAliases(descriptor.rawId), ...taskReferenceAliases(descriptor.id)])) {
      if (!referenceAliases.has(alias)) referenceAliases.set(alias, descriptor.id);
    }
  }
  const tasks = descriptors.map(({ raw, id }) => {
    if (!allowed.has(raw.assigneePetId)) throw new Error('任务 ' + id + ' 使用了未确认的 Agent。');
    const participant = allowed.get(raw.assigneePetId);
    const fallbackAssignee = raw.fallbackAssignee && allowed.has(raw.fallbackAssignee) ? raw.fallbackAssignee : null;
    const fallbackPet = fallbackAssignee ? allowed.get(fallbackAssignee) : participant;
    const allowedFallbacks = new Set([fallbackPet.model || null, fallbackPet.fallbackModel || null]);
    const fallbackModel = allowedFallbacks.has(raw.fallbackModel || null) ? (raw.fallbackModel || null) : (fallbackPet.fallbackModel || fallbackPet.model || null);
    // Some routed models return semantically correct plans with common field
    // aliases even when an output schema was supplied. Normalize those aliases
    // before persistence so a visible `description` or `operation: write` is
    // never silently discarded when the user confirms the plan.
    const brief = String(raw.brief || raw.description || '');
    const requestedMode = raw.mode || raw.operation;
    const mode = ['read', 'write', 'verify'].includes(requestedMode) ? requestedMode : 'read';
    const deliverables = Array.isArray(raw.deliverables) && raw.deliverables.length
      ? raw.deliverables.map(String).slice(0, 30)
      : ['完成任务说明中列出的交付内容，并在报告中列明产物路径'];
    const validation = Array.isArray(raw.validation) && raw.validation.length
      ? raw.validation.map(String).slice(0, 30)
      : ['核对任务说明、文件范围与依赖结论，报告完成情况和未解决问题'];
    return {
      id, title: String(raw.title || id).slice(0, 120), brief, assigneePetId: raw.assigneePetId,
      assigneeName: participant.name, model: participant.model || null, fallbackAssignee, fallbackModel,
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(value => resolveTaskReference(value, referenceAliases) || String(value).trim()) : [],
      mode,
      fileScopes: Array.isArray(raw.fileScopes) ? raw.fileScopes.map(String).slice(0, 50) : [],
      deliverables,
      validation,
      required: raw.required !== false, status: 'blocked', attempts: 0, threadId: null,
      report: null, review: null, changeSet: null, error: null,
    };
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    task.dependsOn = [...new Set(task.dependsOn)];
    if (task.dependsOn.includes(task.id)) throw new Error('任务 ' + task.id + ' 不能依赖自身。');
    for (const dep of task.dependsOn) if (!byId.has(dep)) throw new Error('任务 ' + task.id + ' 引用了不存在的依赖 ' + dep + '。');
  }
  const visiting = new Set();
  const visited = new Set();
  const depth = task => {
    if (visiting.has(task.id)) throw new Error('任务依赖图存在循环。');
    if (visited.has(task.id)) return task.wave;
    visiting.add(task.id);
    task.wave = task.dependsOn.length ? Math.max(...task.dependsOn.map(id => depth(byId.get(id)))) + 1 : 0;
    visiting.delete(task.id); visited.add(task.id); return task.wave;
  };
  tasks.forEach(depth);
  const hasRequiredSink = tasks.some(task => task.required && !tasks.some(other => other.dependsOn.includes(task.id)));
  if (!hasRequiredSink) throw new Error('计划缺少必需的终态交付任务。');
  return { objective: String(rawPlan.objective || rawPlan.goal || ''), assumptions: Array.isArray(rawPlan.assumptions) ? rawPlan.assumptions.map(String) : [], tasks };
}

function publicTaskStatus(status) {
  if (['accepted', 'completed', 'partially_succeeded'].includes(status)) return 'done';
  if (['failed', 'skipped'].includes(status)) return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'interrupted') return 'unknown';
  if (['ready', 'blocked', 'queued', 'retrying'].includes(status)) return 'queued';
  return 'running';
}

class MissionManager {
  constructor({ runtimeRoot, projects, roster, supervisorModel, planner, dispatcher, log = () => {}, onSnapshot = () => {}, onTaskEvent = () => {}, onDone = () => {} }) {
    this.projects = projects;
    this.roster = roster;
    this.supervisorModel = supervisorModel;
    this.planner = planner;
    this.dispatcher = dispatcher;
    this.log = log;
    this.onSnapshot = onSnapshot;
    this.onTaskEvent = onTaskEvent;
    this.onDone = onDone;
    this.store = new MissionStore({ runtimeRoot, log });
    this.workspace = new MissionWorkspace({ runtimeRoot, log });
    this.missions = new Map();
    this.waiters = new Map();
    this.runningMissions = new Set();
    this.operations = new Map();
    this.progressTimers = new Map();
  }

  load() {
    for (const mission of this.store.loadProjects(this.projects())) this.missions.set(mission.id, mission);
    this.emit();
  }

  emit() { this.onSnapshot(this.snapshot()); }
  beginOperation(mission) {
    const previous = this.operations.get(mission.id);
    if (previous) previous.abort();
    const operation = new AbortController();
    this.operations.set(mission.id, operation);
    return operation;
  }
  operation(mission) { return this.operations.get(mission.id) || this.beginOperation(mission); }
  current(mission, operation) {
    return this.operations.get(mission.id) === operation && !operation.signal.aborted
      && !TERMINAL.has(mission.status) && mission.status !== 'interrupted';
  }
  stoppedResult(mission) { return { ok: false, error: 'Mission 已停止，已忽略过期结果。', mission: this.publicMission(mission) }; }
  flushProgress(mission) {
    clearTimeout(this.progressTimers.get(mission.id));
    this.progressTimers.delete(mission.id);
  }
  supervisorRuntime(mission) {
    const dir = path.join(this.store.runtimeDir(mission.id), 'supervisor');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  snapshot() { return [...this.missions.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 40).map(mission => this.publicMission(mission)); }
  get(id) { const mission = this.missions.get(id); return mission ? this.publicMission(mission) : null; }

  publicMission(mission) {
    return sanitizeValue({
      id: mission.id, projectId: mission.projectId, projectName: mission.projectName, objective: mission.objective,
      supervisorThreadId: mission.supervisorThreadId || null, status: mission.status, currentWave: mission.currentWave || 0,
      participants: mission.participants, plan: mission.plan ? { objective: mission.plan.objective, assumptions: mission.plan.assumptions } : null,
      tasks: (mission.tasks || []).map(task => ({
        id: task.id, missionId: mission.id, title: task.title, brief: task.brief, assigneePetId: task.assigneePetId,
        assigneeName: task.assigneeName, model: task.model, fallbackAssignee: task.fallbackAssignee, fallbackModel: task.fallbackModel,
        dependsOn: task.dependsOn, mode: task.mode, fileScopes: task.fileScopes, deliverables: task.deliverables,
        validation: task.validation, required: task.required, status: task.status, wave: task.wave, attempts: task.attempts,
        threadId: task.threadId || null, progress: task.progress || null, progressStage: task.progressStage || null,
        error: task.error || null, review: task.review || null, report: task.report ? { outcome: task.report.outcome, summary: task.report.summary } : null,
      })),
      finalReview: mission.finalReview || null, pendingAction: mission.pendingAction || null,
      error: mission.error || null, createdAt: mission.createdAt, updatedAt: mission.updatedAt, finishedAt: mission.finishedAt || null,
    });
  }

  taskSnapshots() {
    const output = [];
    for (const mission of this.missions.values()) {
      const supervisorStatus = ['awaiting_confirmation', 'needs_input'].includes(mission.status) ? 'waiting_input'
        : (mission.status === 'interrupted' ? 'unknown'
          : (['completed', 'partially_succeeded'].includes(mission.status) ? 'done'
            : (mission.status === 'failed' ? 'failed' : (mission.status === 'cancelled' ? 'cancelled' : 'running'))));
      output.push({
        id: mission.id + ':supervisor', missionId: mission.id, source: 'mission', petId: 'supervisor', petName: '主管',
        model: this.supervisorModel(), brief: mission.objective,
        progress: mission.error || (mission.finalReview && mission.finalReview.summary) || ({ planning: '正在生成任务依赖计划', awaiting_confirmation: '计划已生成，等待确认', running: '正在协调当前执行阶段', reviewing: '正在检查工作者结果', needs_input: 'Mission 等待你的处理', interrupted: 'Mission 已中断，可检查后恢复' }[mission.status] || null),
        progressStage: mission.status === 'reviewing' ? 'finishing' : (['needs_input', 'interrupted'].includes(mission.status) ? 'warning' : 'thinking'),
        status: supervisorStatus, threadId: mission.supervisorThreadId || null, projectId: mission.projectId, projectName: mission.projectName,
        startedAt: mission.createdAt, updatedAt: mission.updatedAt, finishedAt: mission.finishedAt || null,
      });
      for (const task of mission.tasks || []) {
      output.push({
        id: mission.id + ':' + task.id, missionTaskId: task.id, missionId: mission.id, source: 'mission',
        petId: task.assigneePetId, petName: task.assigneeName, model: task.model, brief: task.title || task.brief,
        progress: task.progress || (task.review && task.review.reason) || null, progressStage: task.progressStage || (task.status === 'reviewing' ? 'finishing' : null),
        status: publicTaskStatus(task.status), threadId: task.threadId || null, projectId: mission.projectId, projectName: mission.projectName,
        startedAt: task.startedAt || mission.createdAt, updatedAt: task.updatedAt || mission.updatedAt, finishedAt: task.finishedAt || null,
      });
      }
    }
    return sanitizeValue(output);
  }

  threadIds() {
    const ids = new Set();
    for (const mission of this.missions.values()) {
      if (mission.supervisorThreadId) ids.add(mission.supervisorThreadId);
      for (const task of mission.tasks || []) if (task.threadId) ids.add(task.threadId);
    }
    return ids;
  }

  threadOwner(threadId) {
    if (!threadId) return null;
    for (const mission of this.missions.values()) {
      if (mission.supervisorThreadId === threadId) {
        return {
          missionId: mission.id,
          status: mission.status,
          role: 'supervisor',
          locked: !TERMINAL.has(mission.status),
        };
      }
      for (const task of mission.tasks || []) {
        if (task.threadId !== threadId) continue;
        return {
          missionId: mission.id,
          taskId: task.id,
          status: mission.status,
          taskStatus: task.status,
          role: 'worker',
          locked: ['ready', 'queued', 'running', 'reviewing', 'retrying'].includes(task.status),
        };
      }
    }
    return null;
  }

  transition(mission, status, type, data = {}) {
    this.flushProgress(mission);
    mission.status = status;
    this.store.event(mission, type, data);
    this.store.save(mission);
    this.emit();
  }

  async createDraft({ taskText, projectId, participants }) {
    const project = this.projects().find(item => item.id === projectId);
    if (!project) return { ok: false, error: '还没有项目。请先新建或选择一个项目。' };
    if (project.archived) return { ok: false, error: '这个项目已归档，请先恢复项目。' };
    const allowedRoster = new Map(this.roster().map(item => [item.id, item]));
    const selected = (participants || []).filter(item => item.use && allowedRoster.has(item.petId)).slice(0, 4).map(item => {
      const pet = allowedRoster.get(item.petId);
      return { petId: item.petId, name: item.name || pet.name, model: Object.prototype.hasOwnProperty.call(item, 'model') ? (item.model || null) : (pet.model || null), fallbackModel: item.fallbackModel || null };
    });
    if (!selected.length) return { ok: false, error: '至少选择一个工作者 Agent。' };
    const now = Date.now();
    const mission = {
      schemaVersion: 1, id: missionId(), projectId: project.id, projectName: project.name, projectPath: project.path,
      objective: String(taskText || '').trim(), status: 'planning', participants: selected, tasks: [], plan: null,
      supervisorThreadId: null, currentWave: 0, retryCount: 0, finalReview: null, pendingAction: null,
      createdAt: now, updatedAt: now, eventSequence: 0, messageSequence: 0,
    };
    if (!mission.objective) return { ok: false, error: '任务内容不能为空。' };
    this.missions.set(mission.id, mission);
    this.store.create(mission);
    this.emit();
    const operation = this.beginOperation(mission);
    const result = await this.planner.planMission({
      projectDir: project.path, missionDir: this.supervisorRuntime(mission), objective: mission.objective,
      participants: selected, supervisorModel: this.supervisorModel(), threadId: null, signal: operation.signal,
    });
    if (!this.current(mission, operation)) return this.stoppedResult(mission);
    mission.supervisorThreadId = result.threadId || mission.supervisorThreadId;
    if (!result.ok) {
      mission.error = result.error || '主管规划失败。';
      this.transition(mission, 'needs_input', 'mission.plan_failed', { error: mission.error });
      return { ok: false, mission: this.publicMission(mission), error: mission.error };
    }
    try {
      mission.plan = validatePlan(result.value, selected);
      mission.tasks = mission.plan.tasks;
      this.store.message(mission, { from: 'supervisor', to: 'user', type: 'result', summary: '主管已生成 ' + mission.tasks.length + ' 个任务节点，等待确认。' });
      this.transition(mission, 'awaiting_confirmation', 'mission.plan_ready', { taskCount: mission.tasks.length });
      return { ok: true, mission: this.publicMission(mission) };
    } catch (error) {
      mission.error = error.message;
      this.transition(mission, 'needs_input', 'mission.plan_invalid', { error: error.message });
      return { ok: false, mission: this.publicMission(mission), error: error.message };
    }
  }

  async regenerate(id) {
    const mission = this.missions.get(id);
    if (!mission || !['awaiting_confirmation', 'needs_input'].includes(mission.status)) return { ok: false, error: '当前 Mission 不能重新规划。' };
    this.transition(mission, 'planning', 'mission.replanning');
    const operation = this.beginOperation(mission);
    // Replanning is a complete plan replacement. Start a fresh supervisor
    // thread so an opened Codex Desktop task cannot retain the active-writer
    // lock and block Mission recovery.
    const result = await this.planner.planMission({ projectDir: mission.projectPath, missionDir: this.supervisorRuntime(mission), objective: mission.objective, participants: mission.participants, supervisorModel: this.supervisorModel(), threadId: null, signal: operation.signal });
    if (!this.current(mission, operation)) return this.stoppedResult(mission);
    mission.supervisorThreadId = result.threadId || mission.supervisorThreadId;
    if (!result.ok) { mission.error = result.error; this.transition(mission, 'needs_input', 'mission.plan_failed', { error: result.error }); return { ok: false, error: result.error, mission: this.publicMission(mission) }; }
    try {
      mission.plan = validatePlan(result.value, mission.participants); mission.tasks = mission.plan.tasks; mission.error = null;
      this.transition(mission, 'awaiting_confirmation', 'mission.plan_ready', { taskCount: mission.tasks.length });
      return { ok: true, mission: this.publicMission(mission) };
    } catch (error) { mission.error = error.message; this.transition(mission, 'needs_input', 'mission.plan_invalid', { error: error.message }); return { ok: false, error: error.message, mission: this.publicMission(mission) }; }
  }

  confirm(id) {
    const mission = this.missions.get(id);
    if (!mission || mission.status !== 'awaiting_confirmation') return { ok: false, error: 'Mission 不在等待确认状态。' };
    this.transition(mission, 'running', 'mission.confirmed');
    const operation = this.beginOperation(mission);
    this.run(mission, operation).catch(error => this.failMission(mission, error, operation));
    return { ok: true, mission: this.publicMission(mission) };
  }

  async run(mission, operation = this.operation(mission)) {
    if (this.runningMissions.has(mission.id) || !this.current(mission, operation)) return;
    this.runningMissions.add(mission.id);
    try {
      if (!mission.baseline || !mission.integrationDir || !fs.existsSync(mission.integrationDir)) {
        this.workspace.prepareMission(mission);
        this.store.event(mission, 'mission.workspace_ready', { kind: mission.baseline.kind });
        this.store.save(mission);
      }
      const maxWave = Math.max(0, ...(mission.tasks || []).map(task => task.wave || 0));
      for (let wave = 0; wave <= maxWave; wave++) {
        if (!this.current(mission, operation)) return;
        mission.currentWave = wave;
        const waveTasks = mission.tasks.filter(task => task.wave === wave && !['accepted', 'skipped', 'cancelled'].includes(task.status));
        for (const task of waveTasks) {
          const deps = task.dependsOn.map(id => mission.tasks.find(item => item.id === id));
          if (deps.some(dep => !dep || !(dep.status === 'accepted' || (dep.status === 'skipped' && !dep.required && !dep.error)))) {
            task.status = 'skipped'; task.error = '依赖任务未通过'; task.finishedAt = Date.now();
          } else task.status = 'ready';
        }
        const runnable = waveTasks.filter(task => task.status === 'ready');
        if (!runnable.length) { this.store.save(mission); this.emit(); continue; }
        await this.executeAndReviewWave(mission, runnable, operation);
        if (!this.current(mission, operation) || mission.status === 'needs_input') return;
      }
      if (this.current(mission, operation)) await this.finishMission(mission, operation);
    } finally { this.runningMissions.delete(mission.id); }
  }

  async executeAndReviewWave(mission, tasks, operation = this.operation(mission)) {
    let pending = tasks;
    while (pending.length) {
      if (!this.current(mission, operation)) return;
      this.transition(mission, 'running', 'wave.started', { wave: mission.currentWave, taskIds: pending.map(task => task.id) });
      await Promise.all(pending.map(task => this.executeTask(mission, task, operation)));
      if (!this.current(mission, operation)) return;
      this.transition(mission, 'reviewing', 'wave.review_started', { wave: mission.currentWave });
      const review = await this.planner.reviewWave({ projectDir: mission.projectPath, missionDir: this.supervisorRuntime(mission), mission, tasks: pending, supervisorModel: this.supervisorModel(), threadId: mission.supervisorThreadId, signal: operation.signal });
      if (!this.current(mission, operation)) return;
      mission.supervisorThreadId = review.threadId || mission.supervisorThreadId;
      if (!review.ok) {
        mission.error = '主管阶段检查失败: ' + review.error;
        this.transition(mission, 'needs_input', 'wave.review_failed', { error: review.error });
        return;
      }
      this.store.review(mission, 'wave-' + mission.currentWave + '-attempt-' + (mission.retryCount || 0), review.value);
      const decisionMap = new Map();
      for (const item of review.value.decisions || []) {
        for (const alias of taskReferenceAliases(item.taskId)) decisionMap.set(alias, item);
      }
      const accepted = [];
      const retries = [];
      for (const task of pending) {
        if (task.status === 'cancelled' || task.status === 'interrupted') continue;
        const decision = taskReferenceAliases(task.id).map(alias => decisionMap.get(alias)).find(Boolean)
          || { decision: task.status === 'succeeded' ? 'accept' : 'fail', reason: '主管未返回该节点的明确决策。' };
        task.review = { ...decision, at: Date.now() };
        if (decision.decision === 'accept' && task.status === 'succeeded') {
          task.status = 'accepted'; accepted.push(task);
        } else if (['retry', 'reassign'].includes(decision.decision) && task.attempts < 2) {
          task.status = 'retrying'; task.brief = decision.nextBrief || task.brief;
          if (decision.decision === 'reassign') {
            const next = mission.participants.find(item => item.petId === decision.nextAssignee) || mission.participants.find(item => item.petId === task.fallbackAssignee);
            if (next) {
              task.assigneePetId = next.petId; task.assigneeName = next.name;
              const allowed = new Set([next.model || null]);
              if (next.fallbackModel) allowed.add(next.fallbackModel);
              task.model = allowed.has(decision.nextModel) ? decision.nextModel
                : (allowed.has(task.fallbackModel) ? task.fallbackModel : (next.model || null));
            }
          } else {
            const participant = mission.participants.find(item => item.petId === task.assigneePetId);
            if (participant && decision.nextModel && [participant.model, participant.fallbackModel].includes(decision.nextModel)) task.model = decision.nextModel;
          }
          retries.push(task); mission.retryCount = (mission.retryCount || 0) + 1;
        } else if (decision.decision === 'skip' && !task.required) task.status = 'skipped';
        else { task.status = task.status === 'cancelled' ? 'cancelled' : 'failed'; task.error = decision.reason || task.error; }
        this.store.message(mission, { from: 'supervisor', to: task.assigneePetId, taskId: task.id, type: 'result', summary: decision.decision + '：' + (decision.reason || '') });
      }
      const applied = this.workspace.applyAccepted(mission, accepted);
      if (!applied.ok) {
        mission.pendingAction = { kind: 'merge_conflict', conflicts: applied.conflicts };
        this.transition(mission, 'needs_input', 'wave.merge_conflict', mission.pendingAction);
        return;
      }
      this.store.save(mission); this.emit();
      pending = retries;
    }
  }

  async executeTask(mission, task, operation = this.operation(mission)) {
    if (!this.current(mission, operation) || task.status === 'cancelled') return;
    task.attempts = (task.attempts || 0) + 1;
    task.status = 'queued'; task.error = null; task.report = null; task.changeSet = null; task.updatedAt = Date.now();
    const workspace = this.workspace.prepareTask(mission, task);
    const artifactDir = path.join(this.store.missionDir(mission.projectPath, mission.id), 'artifacts', task.id, 'attempt-' + task.attempts);
    fs.mkdirSync(artifactDir, { recursive: true });
    const runtimeAttempt = path.join(this.store.runtimeDir(mission.id), 'reports', task.id, 'attempt-' + task.attempts);
    fs.mkdirSync(runtimeAttempt, { recursive: true });
    const briefPath = path.join(runtimeAttempt, 'brief.md');
    const resultPath = path.join(runtimeAttempt, 'report.json');
    const schemaPath = path.join(runtimeAttempt, 'worker.schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(WORKER_SCHEMA, null, 2), 'utf8');
    const brief = [
      '# Mission', mission.objective, '# 你的任务', task.title, task.brief,
      '# 允许范围', task.fileScopes.join('\n') || '(未限定；仍只可在当前隔离工作区工作)',
      '# 交付物', task.deliverables.join('\n'), '# 验证要求', task.validation.join('\n') || '(如无法运行请在报告中说明)',
      '# 依赖结论', ...task.dependsOn.map(id => { const dep = mission.tasks.find(item => item.id === id); return '- ' + id + ': ' + ((dep && dep.report && dep.report.summary) || (dep && dep.status) || '未知'); }),
    ].join('\n\n');
    const completion = new Promise(resolve => this.waiters.set(mission.id + ':' + task.id, resolve));
    this.store.message(mission, { from: 'supervisor', to: task.assigneePetId, taskId: task.id, type: 'context', summary: '开始执行：' + task.title });
    this.dispatcher.startTask({
      id: mission.id + ':' + task.id, missionId: mission.id, petId: task.assigneePetId, petName: task.assigneeName,
      model: task.model, brief, projectDir: workspace, briefPath, resultPath, outputSchemaPath: schemaPath,
      skipLegacyDirs: true, threadSource: 'pet-office-worker',
      prompt: 'Complete the assigned work below only inside this isolated workspace. Return the final structured report required by the output schema.\n\n' + brief,
    });
    await completion;
    this.waiters.delete(mission.id + ':' + task.id);
    if (!this.current(mission, operation)) return;
    if (task.status === 'succeeded') {
      try {
        const rawReport = fs.readFileSync(resultPath, 'utf8');
        const parsedReport = this.planner.parseStructuredOutput ? this.planner.parseStructuredOutput(rawReport) : JSON.parse(rawReport);
        task.report = sanitizeValue(normalizeWorkerReport(parsedReport, task));
        fs.writeFileSync(path.join(artifactDir, 'report.json'), JSON.stringify(task.report, null, 2), 'utf8');
      }
      catch (error) { task.status = 'failed'; task.error = '工作者报告解析失败: ' + error.message; }
    }
    if (task.status === 'succeeded') {
      task.changeSet = this.workspace.collect(mission, task, artifactDir);
      task.report.changedFiles = task.changeSet.changes.map(change => change.path);
      for (const message of task.report.messages || []) this.store.message(mission, { ...message, from: task.assigneePetId, taskId: task.id });
      this.store.message(mission, { from: task.assigneePetId, to: 'supervisor', taskId: task.id, type: 'result', summary: task.report.summary, artifactRefs: task.report.artifacts });
    }
    this.store.save(mission); this.emit();
  }

  handleTaskEvent(event) {
    const split = String(event.taskId || '').split(':');
    if (split.length < 2) return false;
    const mission = this.missions.get(split.shift());
    if (!mission) return false;
    const task = mission.tasks.find(item => item.id === split.join(':'));
    if (!task) return false;
    if (TERMINAL.has(mission.status) || mission.status === 'interrupted' || ['cancelled', 'interrupted', 'accepted'].includes(task.status)) {
      if (['done', 'failed', 'cancelled'].includes(event.type)) {
        const resolve = this.waiters.get(mission.id + ':' + task.id);
        if (resolve) resolve();
      }
      return true;
    }
    const now = Date.now();
    if (event.type === 'queued') task.status = 'queued';
    else if (event.type === 'started') { task.status = 'running'; task.startedAt = now; }
    else if (event.type === 'session') task.threadId = event.threadId;
    else if (event.type === 'usage') task.tokens = Math.max(task.tokens || 0, event.tokens || 0);
    else if (event.type === 'progress') { task.progress = String(event.text || '').slice(0, 320); task.progressStage = event.stage || 'working'; }
    else if (event.type === 'done') { task.status = 'succeeded'; task.finishedAt = now; task.elapsedMs = event.elapsedMs || 0; }
    else if (event.type === 'failed') { task.status = 'failed'; task.error = event.error || ('exit ' + event.exitCode); task.finishedAt = now; }
    else if (event.type === 'cancelled') {
      task.status = event.reason === 'app-exit' ? 'interrupted' : 'cancelled';
      task.error = event.reason === 'app-exit' ? 'Pet Office 已退出，等待恢复。' : (event.reason || '已取消');
      task.finishedAt = now;
    }
    task.updatedAt = now;
    if (event.type === 'progress' || event.type === 'usage') {
      if (!this.progressTimers.has(mission.id)) {
        this.progressTimers.set(mission.id, setTimeout(() => {
          this.progressTimers.delete(mission.id);
          this.store.save(mission); this.emit();
        }, 150));
      }
    } else {
      this.flushProgress(mission);
      this.store.save(mission); this.emit();
    }
    this.onTaskEvent(event, mission, sanitizeValue(task));
    if (['done', 'failed', 'cancelled'].includes(event.type)) {
      const resolve = this.waiters.get(mission.id + ':' + task.id);
      if (resolve) resolve();
    }
    return true;
  }

  async finishMission(mission, operation = this.operation(mission)) {
    if (!this.current(mission, operation)) return;
    const incomplete = (mission.tasks || []).filter(task => task.required && task.status !== 'accepted');
    if (incomplete.length) {
      mission.error = '必需任务未通过：' + incomplete.map(task => task.title || task.id).join('、');
      mission.finishedAt = Date.now();
      this.transition(mission, 'failed', 'mission.required_tasks_failed', { taskIds: incomplete.map(task => task.id) });
      this.onDone(this.publicMission(mission));
      return;
    }
    this.transition(mission, 'reviewing', 'mission.final_review_started');
    const review = await this.planner.finalReview({ projectDir: mission.projectPath, missionDir: this.supervisorRuntime(mission), mission, supervisorModel: this.supervisorModel(), threadId: mission.supervisorThreadId, signal: operation.signal });
    if (!this.current(mission, operation)) return;
    mission.supervisorThreadId = review.threadId || mission.supervisorThreadId;
    if (!review.ok) { mission.error = '主管最终复核失败: ' + review.error; this.transition(mission, 'needs_input', 'mission.final_review_failed', { error: review.error }); return; }
    mission.finalReview = review.value;
    this.store.review(mission, 'final', review.value);
    // The structured final review is machine-readable by design, but it also
    // becomes the supervisor thread's last message. Append a plain-language
    // summary turn so opening the finished Mission in Codex shows a readable
    // report instead of raw JSON. A failure here must never change the result.
    try {
      if (typeof this.planner.presentFinal === 'function') {
        Promise.resolve(this.planner.presentFinal({ projectDir: mission.projectPath, missionDir: this.supervisorRuntime(mission), threadId: mission.supervisorThreadId, supervisorModel: this.supervisorModel(), review: review.value, signal: operation.signal }))
          .catch(error => this.log('主管最终总结生成失败: ' + ((error && error.message) || error)));
      }
    } catch (error) {
      this.log('主管最终总结提交失败: ' + ((error && error.message) || error));
    }
    if (review.value.verdict === 'fail') { mission.finishedAt = Date.now(); this.transition(mission, 'failed', 'mission.failed', { reason: review.value.summary }); this.onDone(this.publicMission(mission)); return; }
    const artifactDir = path.join(this.store.missionDir(mission.projectPath, mission.id), 'artifacts', 'integration');
    mission.finalChangeSet = this.workspace.finalChangeSet(mission, artifactDir);
    const preflight = this.workspace.preflightMain(mission, mission.finalChangeSet);
    if (!preflight.ok) { mission.pendingAction = { kind: preflight.kind, conflicts: preflight.conflicts }; this.transition(mission, 'needs_input', 'mission.integration_blocked', mission.pendingAction); return; }
    if (preflight.highRisk) { mission.pendingAction = { kind: 'high_risk', deletes: preflight.deletes, binaries: preflight.binaries, outOfScope: preflight.outOfScope }; this.transition(mission, 'needs_input', 'mission.high_risk_confirmation', mission.pendingAction); return; }
    this.applyFinal(mission);
  }

  applyFinal(mission) {
    if (!this.current(mission, this.operation(mission))) return;
    const result = this.workspace.applyFinal(mission, mission.finalChangeSet);
    mission.pendingAction = null; mission.finishedAt = Date.now(); mission.applyBackup = result.backup;
    const status = mission.finalReview && mission.finalReview.verdict === 'partial' ? 'partially_succeeded' : 'completed';
    this.transition(mission, status, 'mission.completed', { verdict: mission.finalReview && mission.finalReview.verdict });
    this.workspace.cleanupSuccessful(mission);
    this.store.message(mission, { from: 'supervisor', to: 'user', type: 'result', summary: mission.finalReview ? mission.finalReview.summary : 'Mission 已完成。' });
    this.onDone(this.publicMission(mission));
  }

  resolveConflict(id, action) {
    const mission = this.missions.get(id);
    if (!mission || mission.status !== 'needs_input' || !mission.pendingAction) return { ok: false, error: '没有等待处理的集成问题。' };
    if (mission.pendingAction.kind === 'high_risk' && action === 'apply') {
      const preflight = this.workspace.preflightMain(mission, mission.finalChangeSet);
      if (!preflight.ok) { mission.pendingAction = { kind: preflight.kind, conflicts: preflight.conflicts }; this.transition(mission, 'needs_input', 'mission.integration_blocked', mission.pendingAction); return { ok: false, error: '主项目在确认期间发生变化，已停止回写。', mission: this.publicMission(mission) }; }
      this.applyFinal(mission); return { ok: true, mission: this.publicMission(mission) };
    }
    if (action === 'mark-resolved') {
      mission.pendingAction = null; mission.finishedAt = Date.now();
      const status = mission.finalReview && mission.finalReview.verdict === 'partial' ? 'partially_succeeded' : 'completed';
      this.transition(mission, status, 'mission.manually_resolved');
      return { ok: true, mission: this.publicMission(mission) };
    }
    return { ok: false, error: '该冲突需要在项目中手动处理，然后选择“已处理”。' };
  }

  cancel(id) {
    const mission = this.missions.get(id);
    if (!mission || TERMINAL.has(mission.status)) return { ok: false, error: 'Mission 已结束。' };
    mission.status = 'cancelled'; mission.finishedAt = Date.now();
    const operation = this.operations.get(mission.id);
    if (operation) operation.abort();
    for (const task of mission.tasks || []) {
      if (['queued', 'running', 'reviewing', 'retrying'].includes(task.status)) this.dispatcher.cancel(mission.id + ':' + task.id);
      if (!['accepted', 'failed', 'skipped'].includes(task.status)) task.status = 'cancelled';
    }
    this.transition(mission, 'cancelled', 'mission.cancelled'); this.onDone(this.publicMission(mission));
    return { ok: true, mission: this.publicMission(mission) };
  }

  cancelTask(id, taskIdValue) {
    const mission = this.missions.get(id); const task = mission && mission.tasks.find(item => item.id === taskIdValue);
    if (!task) return { ok: false, error: '找不到任务节点。' };
    if (TERMINAL.has(mission.status) || ['accepted', 'failed', 'skipped', 'cancelled'].includes(task.status)) return { ok: false, error: '任务节点已结束。' };
    task.status = 'cancelled'; task.finishedAt = Date.now();
    this.dispatcher.cancel(mission.id + ':' + task.id);
    for (const dependent of mission.tasks.filter(item => item.dependsOn.includes(task.id) && !['accepted', 'failed', 'cancelled'].includes(item.status))) dependent.status = 'blocked';
    this.store.event(mission, 'task.cancelled', { taskId: task.id }); this.store.save(mission); this.emit();
    return { ok: true, mission: this.publicMission(mission) };
  }

  async resume(id) {
    const mission = this.missions.get(id);
    if (!mission || mission.status !== 'interrupted') return { ok: false, error: 'Mission 不在可恢复状态。' };
    const operation = this.beginOperation(mission);
    if (!mission.plan || !(mission.tasks || []).length) {
      this.transition(mission, 'planning', 'mission.planning_resumed');
      const result = await this.planner.planMission({ projectDir: mission.projectPath, missionDir: this.supervisorRuntime(mission), objective: mission.objective, participants: mission.participants, supervisorModel: this.supervisorModel(), threadId: mission.supervisorThreadId, signal: operation.signal });
      if (!this.current(mission, operation)) return this.stoppedResult(mission);
      mission.supervisorThreadId = result.threadId || mission.supervisorThreadId;
      if (!result.ok) { mission.error = result.error; this.transition(mission, 'needs_input', 'mission.plan_failed', { error: result.error }); return { ok: false, error: result.error, mission: this.publicMission(mission) }; }
      try { mission.plan = validatePlan(result.value, mission.participants); mission.tasks = mission.plan.tasks; this.transition(mission, 'awaiting_confirmation', 'mission.plan_ready', { recovered: true }); return { ok: true, mission: this.publicMission(mission) }; }
      catch (error) { mission.error = error.message; this.transition(mission, 'needs_input', 'mission.plan_invalid', { error: error.message }); return { ok: false, error: error.message, mission: this.publicMission(mission) }; }
    }
    for (const task of mission.tasks || []) if (!['accepted', 'skipped', 'failed', 'cancelled'].includes(task.status)) task.status = 'blocked';
    mission.error = null; mission.pendingAction = null;
    this.transition(mission, 'running', 'mission.resumed');
    this.run(mission, operation).catch(error => this.failMission(mission, error, operation));
    return { ok: true, mission: this.publicMission(mission) };
  }

  failMission(mission, error, operation = this.operation(mission)) {
    if (!this.current(mission, operation)) return;
    this.log('mission failed: ' + (error && error.stack || error));
    mission.error = String(error && error.message || error); mission.finishedAt = Date.now();
    this.transition(mission, 'failed', 'mission.failed', { error: mission.error }); this.onDone(this.publicMission(mission));
    operation.abort();
    for (const task of mission.tasks || []) if (['queued', 'running', 'reviewing'].includes(task.status)) {
      task.status = 'cancelled';
      this.dispatcher.cancel(mission.id + ':' + task.id);
    }
    this.store.save(mission); this.emit();
  }

  shutdown() {
    for (const mission of this.missions.values()) {
      this.flushProgress(mission);
      const operation = this.operations.get(mission.id);
      if (operation) operation.abort();
      if (!['running', 'reviewing', 'planning'].includes(mission.status)) continue;
      mission.status = 'interrupted'; mission.interruptionReason = 'Pet Office 正在退出。';
      for (const task of mission.tasks || []) if (['queued', 'running', 'reviewing'].includes(task.status)) task.status = 'interrupted';
      this.store.event(mission, 'mission.interrupted', { reason: mission.interruptionReason }); this.store.save(mission);
    }
    this.emit();
  }
}

module.exports = { MissionManager, validatePlan, normalizeWorkerReport, publicTaskStatus, WORKER_SCHEMA, TERMINAL };
