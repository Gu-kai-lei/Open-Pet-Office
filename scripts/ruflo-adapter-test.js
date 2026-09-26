'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RufloMcpClient, REQUIRED_TOOLS, _internals } = require('../src/ruflo-runtime');
const { RufloAdapter, FakeRufloAdapter, projectNamespace, sanitizeMemory, normalizeHits } = require('../src/ruflo-adapter');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-ruflo-test-'));
const server = path.join(root, 'fake-mcp.js');
fs.writeFileSync(server, `
'use strict';
const tools = ${JSON.stringify(REQUIRED_TOOLS)}.map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'notifications/initialized') continue;
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: '2024-11-05', serverInfo: { name: 'fake-ruflo', version: '3.43.0' }, capabilities: { tools: {} } };
    if (m.method === 'tools/list') result = { tools };
    if (m.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ success: true, name: m.params.name, args: m.params.arguments }) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`, 'utf8');

(async () => {
  assert(_internals.atLeast('v20.1.0', 20, 0));
  assert(!_internals.atLeast('v18.20.0', 20, 0));
  assert.notEqual(projectNamespace('A'), projectNamespace('B'));
  const safe = sanitizeMemory({ summary: 'token=secret-value C:\\Users\\alice\\private\\file.md', rawAttachment: 'private bytes' });
  assert(!JSON.stringify(safe).includes('secret-value'));
  assert(!JSON.stringify(safe).includes('private bytes'));
  assert(normalizeHits({ results: [{ key: 'x', value: 'y', similarity: .8 }] })[0].similarity >= .7);

  const client = new RufloMcpClient({ command: process.execPath, args: [server], cwd: root, env: process.env });
  await client.start();
  assert.equal(client.tools.length, REQUIRED_TOOLS.length);
  const called = await client.call('task_update', { taskId: 't1', status: 'running' });
  assert.equal(called.name, 'task_update');
  assert.equal(called.args.taskId, 't1');
  client.stop();

  const calls = [];
  const runtime = {
    async health() { return { ready: true }; },
    async client() {
      return { call: async (name, args) => {
        calls.push({ name, args });
        if (name === 'swarm_init') return { success: true, swarmId: 's1' };
        if (name === 'agent_spawn') return { success: true, agentId: args.agentId };
        if (name === 'task_create') return { success: true, taskId: 'rt1' };
        if (name === 'memory_search') return { results: [{ key: 'pattern', value: 'safe', similarity: .9 }] };
        return { success: true };
      } };
    },
    projectDir() { return root; },
    workerMcpConfig() { return { command: 'node.exe', args: ['wrapper.mjs'], env: {} }; },
    shutdown() {},
  };
  const adapter = new RufloAdapter({ runtime });
  const swarm = await adapter.createSwarm('p1', { memoryNamespace: projectNamespace('p1') });
  assert.equal(swarm.swarmId, 's1');
  assert.deepEqual(calls.slice(0, 2).map(call => call.name), ['coordination_topology', 'swarm_init']);
  const task = await adapter.createTask('p1', { missionId: 'm1', localTaskId: 't1', description: 'work', dependsOn: ['t0'], agentId: 'a1' });
  assert.equal(task.taskId, 'rt1');
  assert(calls.find(call => call.name === 'task_create').args.tags.includes('depends:t0'));
  await adapter.routeModel('p1', { task: 'implement feature', context: 'role=coder' });
  const routeCall = calls.find(call => call.name === 'hooks_route');
  assert(routeCall && routeCall.args.useSemanticRouter === false);
  assert.equal((await adapter.searchMemory('p1', { query: 'pattern', threshold: .7 })).length, 1);

  const fake = new FakeRufloAdapter();
  await fake.storeMemory('A', { namespace: fake.namespace('A'), value: 'A only' });
  await fake.storeMemory('B', { namespace: fake.namespace('B'), value: 'B only' });
  assert.equal((await fake.searchMemory('A', { namespace: fake.namespace('A') })).length, 1);
  assert.equal((await fake.searchMemory('A', { namespace: fake.namespace('B') })).length, 0);

  console.log('ruflo adapter tests passed');
  fs.rmSync(root, { recursive: true, force: true });
})().catch(error => {
  console.error(error);
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
});
