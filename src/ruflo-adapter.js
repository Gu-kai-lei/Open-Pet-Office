'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact, RUFLO_VERSION } = require('./ruflo-runtime');

function projectNamespace(projectId) {
  const stable = crypto.createHash('sha256').update(String(projectId || '')).digest('hex').slice(0, 20);
  return 'pet-office-project-' + stable;
}

function sanitizeMemory(value) {
  const walk = (input, key = '') => {
    if (typeof input === 'string') {
      let text = redact(input)
        .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+\\/gi, '[PRIVATE_PATH]\\')
        .replace(/\b[A-Za-z]:\\[^\r\n,;]+/g, '[ABSOLUTE_PATH]');
      if (/attachment|附件/i.test(key)) text = '[附件内容不写入记忆]';
      return text.slice(0, 6000);
    }
    if (Array.isArray(input)) return input.slice(0, 50).map(item => walk(item, key));
    if (input && typeof input === 'object') {
      const output = {};
      for (const [childKey, child] of Object.entries(input)) {
        if (/^(api.?key|token|password|secret|authorization|rawAttachment|conversation)$/i.test(childKey)) continue;
        output[childKey] = walk(child, childKey);
      }
      return output;
    }
    return input;
  };
  return walk(value);
}

function normalizeHits(result) {
  const items = Array.isArray(result) ? result
    : (result && (result.results || result.memories || result.items || result.data)) || [];
  return (Array.isArray(items) ? items : []).map(item => ({
    key: item.key || item.id || null,
    value: sanitizeMemory(item.value == null ? (item.content || item.text || '') : item.value),
    similarity: Number(item.similarity == null ? (item.score == null ? item.rankingScore : item.score) : item.similarity) || 0,
    namespace: item.namespace || null,
    tags: Array.isArray(item.tags) ? item.tags : [],
  }));
}

class RufloAdapter {
  constructor({ runtime, log = () => {} }) {
    this.runtime = runtime;
    this.log = log;
    this.eventSequence = new Map();
  }

  health(projectId, options) { return this.runtime.health(projectId, options); }
  install(options) { return this.runtime.install(options); }
  repair(options) { return this.runtime.repair(options); }
  shutdown() { this.runtime.shutdown(); }
  namespace(projectId) { return projectNamespace(projectId); }
  workerMcpConfig(projectId, missionId, taskId) { return this.runtime.workerMcpConfig(projectId, missionId, taskId); }

  async call(projectId, name, args = {}) {
    const client = await this.runtime.client(projectId);
    const result = await client.call(name, args);
    if (result && result.success === false) throw new Error(result.error || (name + ' failed'));
    return result;
  }

  async createSwarm(projectId, options = {}) {
    await this.call(projectId, 'coordination_topology', {
      action: 'set', type: options.topology || 'hierarchical', maxNodes: options.maxAgents || 5,
      redundancy: 1, consensusAlgorithm: options.consensus || 'raft',
    });
    const result = await this.call(projectId, 'swarm_init', {
      topology: options.topology || 'hierarchical', maxAgents: options.maxAgents || 5,
      strategy: options.strategy || 'specialized',
      config: {
        consensusMechanism: options.consensus || 'raft',
        communicationProtocol: 'message-bus', autoScaling: false,
        memoryNamespace: options.memoryNamespace || this.namespace(projectId),
        trackHostProcess: false,
      },
    });
    this.recordEvent(projectId, 'swarm.created', result);
    return result;
  }

  getSwarm(projectId, swarmId) { return this.call(projectId, 'swarm_status', { swarmId }); }
  async stopSwarm(projectId, swarmId) {
    const result = await this.call(projectId, 'swarm_shutdown', { swarmId, graceful: true });
    this.recordEvent(projectId, 'swarm.stopped', { swarmId });
    return result;
  }

  async spawnAgent(projectId, options) {
    const result = await this.call(projectId, 'agent_spawn', {
      agentType: options.role || 'coder', agentId: options.agentId,
      swarmId: options.swarmId, model: 'inherit', task: options.task,
      domain: 'pet-office',
      config: {
        petId: options.petId, requestedModel: options.requestedModel || null,
        actualModel: options.actualModel || null, modelReason: options.modelReason || '',
      },
    });
    this.recordEvent(projectId, 'agent.spawned', result);
    return result;
  }

  getAgent(projectId, agentId) { return this.call(projectId, 'agent_status', { agentId }); }

  routeModel(projectId, { task, context = '' } = {}) {
    return this.call(projectId, 'hooks_route', {
      task: String(task || ''), context: String(context || ''),
      // Ruflo's local keyword router is deterministic and does not require
      // downloading an embedding model. Pet Office maps its complexity/role
      // recommendation to models that are actually present in Codex.
      useSemanticRouter: false,
    });
  }

  async createTask(projectId, options) {
    const tags = [
      'pet-office', 'mission:' + options.missionId, 'node:' + options.localTaskId,
      ...(options.dependsOn || []).map(id => 'depends:' + id),
      ...(options.tags || []),
    ];
    const result = await this.call(projectId, 'task_create', {
      type: options.type || 'feature', description: options.description,
      priority: options.priority || 'normal',
      assignTo: options.agentId ? [options.agentId] : [], tags,
    });
    this.recordEvent(projectId, 'task.created', { ...result, dependencies: options.dependsOn || [] });
    return result;
  }

  assignTask(projectId, taskId, agentIds) { return this.call(projectId, 'task_assign', { taskId, agentIds }); }
  getTasks(projectId, filters = {}) { return this.call(projectId, 'task_list', filters); }
  updateTask(projectId, taskId, patch = {}) { return this.call(projectId, 'task_update', { taskId, ...patch }); }
  cancelTask(projectId, taskId, reason) { return this.call(projectId, 'task_cancel', { taskId, reason }); }
  retryTask(projectId, taskId) { return this.call(projectId, 'task_retry', { taskId, resetState: true }); }
  completeTask(projectId, taskId, result) { return this.call(projectId, 'task_complete', { taskId, result: sanitizeMemory(result) }); }

  async searchMemory(projectId, { query, namespace, limit = 5, threshold = 0.7 } = {}) {
    const result = await this.call(projectId, 'memory_search', {
      query, namespace: namespace || this.namespace(projectId), limit: Math.min(5, limit), threshold, smart: true,
    });
    return normalizeHits(result).filter(hit => hit.similarity >= threshold).slice(0, 5);
  }

  storeMemory(projectId, { key, value, namespace, tags = [] } = {}) {
    return this.call(projectId, 'memory_store', {
      key, value: sanitizeMemory(value), namespace: namespace || this.namespace(projectId),
      tags: ['pet-office', ...tags].slice(0, 20), upsert: true, provenance_type: 'system_observation',
    });
  }

  eventFile(projectId) { return path.join(this.runtime.projectDir(projectId), 'pet-office-events.jsonl'); }
  recordEvent(projectId, type, data = {}) {
    const sequence = (this.eventSequence.get(projectId) || 0) + 1;
    this.eventSequence.set(projectId, sequence);
    const event = { sequence, at: Date.now(), type, data: sanitizeMemory(data) };
    try { fs.appendFileSync(this.eventFile(projectId), JSON.stringify(event) + '\n', 'utf8'); } catch {}
    return event;
  }

  listEvents(projectId, after = 0, limit = 200) {
    try {
      return fs.readFileSync(this.eventFile(projectId), 'utf8').split(/\r?\n/).filter(Boolean)
        .map(line => JSON.parse(line)).filter(event => event.sequence > after).slice(0, limit);
    } catch { return []; }
  }

  async sendMessage(projectId, { missionId, from, to, type = 'context', summary, taskId = null } = {}) {
    const event = this.recordEvent(projectId, 'message.sent', { missionId, taskId, from, to, type, summary });
    await this.storeMemory(projectId, {
      key: ['message', missionId, taskId || 'mission', event.sequence].join('-'),
      value: { missionId, taskId, from, to, type, summary },
      tags: ['message', 'mission:' + missionId, 'to:' + to],
    });
    return event;
  }

  async reconcile(projectId, mission) {
    const differences = [];
    const swarm = mission.swarmId ? await this.getSwarm(projectId, mission.swarmId) : null;
    if (!swarm || ['terminated', 'no_swarm'].includes(swarm.status)) differences.push({ kind: 'swarm', local: mission.status, remote: swarm && swarm.status });
    const remote = await this.getTasks(projectId, { limit: 200 });
    const rows = Array.isArray(remote) ? remote : (remote.tasks || remote.items || []);
    const byId = new Map(rows.map(task => [task.taskId || task.id, task]));
    for (const task of mission.tasks || []) {
      if (!task.rufloTaskId) continue;
      const match = byId.get(task.rufloTaskId);
      if (!match) differences.push({ kind: 'task_missing', taskId: task.id, rufloTaskId: task.rufloTaskId });
    }
    return { ok: differences.length === 0, swarm, tasks: rows, differences };
  }
}

class FakeRufloAdapter {
  constructor() { this.counter = 0; this.tasks = new Map(); this.memories = []; }
  namespace(projectId) { return projectNamespace(projectId); }
  async health() { return { ready: true, state: 'ready', version: RUFLO_VERSION, checks: {} }; }
  async createSwarm() { return { success: true, swarmId: 'swarm-test', topology: 'hierarchical' }; }
  async getSwarm() { return { status: 'running', swarmId: 'swarm-test' }; }
  async stopSwarm() { return { success: true }; }
  async spawnAgent(projectId, options) { return { success: true, agentId: options.agentId || ('agent-' + ++this.counter) }; }
  async routeModel(projectId, options = {}) {
    const task = String(options.task || '');
    const complexity = task.length > 200 ? 'high' : (task.length < 50 ? 'low' : 'medium');
    return { primaryAgent: { type: 'coder', reason: 'fake route' }, estimatedMetrics: { complexity } };
  }
  async createTask(projectId, options) { const taskId = 'ruflo-task-' + ++this.counter; this.tasks.set(taskId, { taskId, status: 'pending', ...options }); return { success: true, taskId }; }
  async assignTask() { return { success: true }; }
  async updateTask(projectId, taskId, patch) { Object.assign(this.tasks.get(taskId) || {}, patch); return { success: true, taskId, ...patch }; }
  async completeTask(projectId, taskId, result) { Object.assign(this.tasks.get(taskId) || {}, { status: 'completed', result }); return { success: true }; }
  async cancelTask(projectId, taskId) { Object.assign(this.tasks.get(taskId) || {}, { status: 'cancelled' }); return { success: true }; }
  async retryTask() { return { success: true, taskId: 'ruflo-task-' + ++this.counter }; }
  async getTasks() { return { tasks: [...this.tasks.values()] }; }
  async searchMemory(projectId, options = {}) { return this.memories.filter(item => item.projectId === projectId && (!options.namespace || item.namespace === options.namespace)).slice(0, 5); }
  async storeMemory(projectId, item) { this.memories.push({ ...item, projectId }); return { success: true }; }
  async sendMessage() { return { success: true }; }
  listEvents() { return []; }
  workerMcpConfig() { return null; }
  async reconcile() { return { ok: true, differences: [] }; }
  shutdown() {}
}

module.exports = { RufloAdapter, FakeRufloAdapter, projectNamespace, sanitizeMemory, normalizeHits };
