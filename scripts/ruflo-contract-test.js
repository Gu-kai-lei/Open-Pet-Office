'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const { RufloRuntimeManager, RUFLO_VERSION, RUFLO_CLI_VERSION } = require('../src/ruflo-runtime');
const { RufloAdapter } = require('../src/ruflo-adapter');

const root = process.env.PET_OFFICE_RUFLO_ROOT || path.join(os.homedir(), '.pet-office', 'ruflo');
const projectId = 'contract-' + Date.now().toString(36);
const runtime = new RufloRuntimeManager({ root, log: message => process.stderr.write(String(message) + '\n') });
const adapter = new RufloAdapter({ runtime, log: message => process.stderr.write(String(message) + '\n') });

(async () => {
  let health = await adapter.health(projectId, { probe: true });
  if (!health.ready && process.argv.includes('--install')) {
    health = await adapter.install({ onProgress: message => message && process.stderr.write(String(message) + '\n') });
  }
  assert.equal(health.ready, true, 'Ruflo runtime must be ready: ' + JSON.stringify(health));
  assert.equal(health.checks.runtime.value.ruflo, RUFLO_VERSION);
  assert.equal(health.checks.runtime.value.cli, RUFLO_CLI_VERSION);

  const namespace = 'pet-office-contract-' + Date.now().toString(36);
  const swarm = await adapter.createSwarm(projectId, { topology: 'hierarchical', strategy: 'specialized', consensus: 'raft', maxAgents: 3, memoryNamespace: namespace });
  assert(swarm.swarmId);
  const status = await adapter.getSwarm(projectId, swarm.swarmId);
  assert.equal(status.status, 'running');

  const agent = await adapter.spawnAgent(projectId, { agentId: 'contract-researcher', role: 'researcher', swarmId: swarm.swarmId, petId: 'w1', task: 'contract test' });
  const agentId = agent.agentId || 'contract-researcher';
  const agentStatus = await adapter.getAgent(projectId, agentId);
  assert(agentStatus.agentId || agentStatus.id || agentStatus.success);

  await adapter.storeMemory(projectId, { key: 'contract-memory', namespace, value: { pattern: 'Pet Office Ruflo contract marker' }, tags: ['contract'] });
  const hits = await adapter.searchMemory(projectId, { query: 'Pet Office Ruflo contract marker', namespace, limit: 5, threshold: 0.1 });
  assert(hits.length >= 1, 'stored memory must be searchable');

  const first = await adapter.createTask(projectId, { missionId: 'contract', localTaskId: 't1', description: 'contract task one', type: 'research', agentId, dependsOn: [] });
  const second = await adapter.createTask(projectId, { missionId: 'contract', localTaskId: 't2', description: 'contract task two', type: 'feature', agentId, dependsOn: ['t1'] });
  assert(first.taskId && second.taskId);
  await adapter.assignTask(projectId, second.taskId, [agentId]);
  await adapter.updateTask(projectId, second.taskId, { status: 'blocked', progress: 0 });
  await adapter.updateTask(projectId, second.taskId, { status: 'pending', progress: 0 });
  await adapter.updateTask(projectId, first.taskId, { status: 'in_progress', progress: 50 });
  await adapter.completeTask(projectId, first.taskId, { summary: 'contract complete' });
  await adapter.cancelTask(projectId, second.taskId, 'contract cancellation');
  const retried = await adapter.retryTask(projectId, second.taskId);
  assert(retried.taskId || retried.id);
  const tasks = await adapter.getTasks(projectId, { limit: 20 });
  assert((tasks.tasks || tasks.items || tasks).length >= 3);
  await adapter.stopSwarm(projectId, swarm.swarmId);
  const stopped = await adapter.getSwarm(projectId, swarm.swarmId);
  assert.equal(stopped.status, 'terminated');
  adapter.shutdown();
  console.log('ruflo 3.43.0 Windows contract passed');
})().catch(error => {
  adapter.shutdown();
  console.error(error);
  process.exitCode = 1;
});
