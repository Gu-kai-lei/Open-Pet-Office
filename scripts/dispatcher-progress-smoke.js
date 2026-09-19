'use strict';

const assert = require('assert');
const { progressFromEvent } = require('../src/dispatcher')._internals;

const command = progressFromEvent({
  type: 'item.started',
  item: { type: 'command_execution', command: 'npm test -- --runInBand' },
});
assert.deepStrictEqual(command, { stage: 'command', text: '运行命令 · npm test -- --runInBand' });

const file = progressFromEvent({
  type: 'item.completed',
  item: { type: 'file_change', path: 'src/status-badge.tsx' },
});
assert.deepStrictEqual(file, { stage: 'file', text: '更新文件 · src/status-badge.tsx' });

const report = progressFromEvent({
  type: 'item.completed',
  item: { type: 'agent_message', text: '界面与单元测试已完成。' },
});
assert.deepStrictEqual(report, { stage: 'report', text: '界面与单元测试已完成。' });

assert.strictEqual(progressFromEvent({ type: 'unrelated' }), null);
console.log('dispatcher progress smoke: OK');
