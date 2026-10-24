'use strict';

// Built-in Mission coordinator. Pet Office's MissionStore is already the source
// of truth for plans, task states and team messages, so this engine needs no
// external runtime: task bookkeeping is acknowledged in-process and only
// project memory is persisted (one JSON file per namespace).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectNamespace, sanitizeMemory } = require('./coordination-utils');

const ENGINE_VERSION = 'local-1';
const MAX_ENTRIES_PER_NAMESPACE = 500;
// Callers pass thresholds calibrated for embedding similarity (~0.7). Keyword
// overlap scores are lower for equally relevant text, so local search applies
// its own floor instead of silently returning nothing. Requiring two shared
// tokens keeps single common words from matching unrelated memories.
const KEYWORD_MIN_SCORE = 0.12;
const MIN_SHARED_TOKENS = 2;

// Only values carry meaning; object keys such as "summary" would otherwise
// make every stored result look similar.
function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (typeof value === 'object') return Object.values(value).map(textOf).join(' ');
  return String(value);
}

function tokens(value) {
  const text = textOf(value).toLowerCase();
  const output = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9_.-]{1,}/g) || []) output.add(word);
  // CJK text has no spaces; overlapping character pairs are a robust,
  // dependency-free approximation of words.
  for (const run of text.match(/[㐀-鿿]+/g) || []) {
    if (run.length === 1) output.add(run);
    for (let index = 0; index < run.length - 1; index++) output.add(run.slice(index, index + 2));
  }
  return output;
}

function similarity(query, document) {
  if (!query.size || !document.size) return 0;
  let shared = 0;
  for (const token of query) if (document.has(token)) shared++;
  if (shared < Math.min(MIN_SHARED_TOKENS, query.size)) return 0;
  return shared / Math.sqrt(query.size * document.size);
}

function safeFileName(namespace) {
  const plain = String(namespace || 'default').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'default';
  return plain + '.json';
}

function complexityOf(text) {
  const value = String(text || '');
  if (value.length > 600 || /架构|重构|迁移|并发|安全|性能|architecture|refactor|migrat|concurren|security|performance/i.test(value)) return 'high';
  if (value.length < 120) return 'low';
  return 'medium';
}

class LocalCoordinator {
  constructor({ root, log = () => {} } = {}) {
    this.root = root;
    this.log = log;
    this.sequence = 0;
  }

  get engine() { return 'local'; }
  namespace(projectId) { return projectNamespace(projectId); }
  async health() { return { ready: true, state: 'ready', engine: 'local', version: ENGINE_VERSION, checks: {}, checkedAt: Date.now() }; }
  async install() { return this.health(); }
  async repair() { return this.health(); }
  shutdown() {}
  workerMcpConfig() { return null; }

  id(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + (++this.sequence).toString(36) + crypto.randomBytes(2).toString('hex'); }

  async createSwarm() { return { success: true, swarmId: this.id('local-team'), engine: 'local' }; }
  async getSwarm(projectId, swarmId) { return { success: true, swarmId, status: 'running' }; }
  async stopSwarm() { return { success: true }; }
  async spawnAgent(projectId, options = {}) { return { success: true, agentId: options.agentId || this.id('agent') }; }

  // Deterministic routing hint; MissionManager maps it onto models that exist.
  async routeModel(projectId, { task, context = '' } = {}) {
    const role = (String(context).match(/role=([a-z]+)/) || [])[1] || 'coder';
    return { primaryAgent: { type: role, confidence: 0.5, reason: 'local heuristic' }, estimatedMetrics: { complexity: complexityOf(task) } };
  }

  async createTask(projectId, options = {}) { return { success: true, taskId: this.id('local-task'), status: 'pending', localTaskId: options.localTaskId || null }; }
  async assignTask() { return { success: true }; }
  async updateTask(projectId, taskId, patch = {}) { return { success: true, taskId, ...patch }; }
  async completeTask(projectId, taskId) { return { success: true, taskId, status: 'completed' }; }
  async cancelTask(projectId, taskId) { return { success: true, taskId, status: 'cancelled' }; }
  async retryTask() { return { success: true, taskId: this.id('local-task'), status: 'pending' }; }
  async getTasks() { return { tasks: [] }; }
  // Team messages already live in .pet-office/missions/<id>/messages.jsonl.
  async sendMessage() { return { success: true }; }
  recordEvent(projectId, type, data = {}) { return { sequence: ++this.sequence, at: Date.now(), type, data }; }
  listEvents() { return []; }
  async reconcile() { return { ok: true, differences: [] }; }

  memoryFile(namespace) {
    fs.mkdirSync(this.root, { recursive: true });
    return path.join(this.root, safeFileName(namespace));
  }

  readMemory(namespace) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.memoryFile(namespace), 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  async storeMemory(projectId, { key, value, namespace, tags = [] } = {}) {
    const target = namespace || this.namespace(projectId);
    const entries = this.readMemory(target).filter(entry => entry.key !== key);
    entries.push({ key: String(key || this.id('memory')), value: sanitizeMemory(value), namespace: target, tags: ['pet-office', ...tags].slice(0, 20), at: Date.now() });
    const file = this.memoryFile(target);
    const next = file + '.next';
    fs.writeFileSync(next, JSON.stringify(entries.slice(-MAX_ENTRIES_PER_NAMESPACE), null, 2), 'utf8');
    fs.renameSync(next, file);
    return { success: true, key };
  }

  async searchMemory(projectId, { query, namespace, limit = 5 } = {}) {
    const target = namespace || this.namespace(projectId);
    const wanted = tokens(query);
    return this.readMemory(target)
      .map(entry => ({
        key: entry.key, value: entry.value, namespace: entry.namespace || target, tags: entry.tags || [],
        similarity: Number(similarity(wanted, tokens(entry.value)).toFixed(3)),
      }))
      .filter(hit => hit.similarity >= KEYWORD_MIN_SCORE)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, Math.min(5, limit));
  }
}

module.exports = { LocalCoordinator, ENGINE_VERSION, _internals: { tokens, similarity, complexityOf } };
