'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const code = source.slice(source.indexOf('function appServerItemProgress('), source.indexOf('function finishChat('));
const context = {};
vm.createContext(context);
vm.runInContext(code, context);

assert.deepEqual(
  JSON.parse(JSON.stringify(context.appServerItemProgress('item/started', { type: 'commandExecution', command: 'npm test' }))),
  { stage: 'command', text: '正在运行命令 · npm test' },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.appServerItemProgress('item/completed', { type: 'fileChange', path: 'src/app.js' }))),
  { stage: 'file', text: '已更新文件 · src/app.js' },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.appServerItemProgress('item/started', { type: 'mcpToolCall', name: 'search' }))),
  { stage: 'tool', text: '正在调用工具 · search' },
);
assert.equal(context.appServerItemProgress('unrelated', { type: 'commandExecution' }), null);
console.log('app-server progress mapping: OK');
