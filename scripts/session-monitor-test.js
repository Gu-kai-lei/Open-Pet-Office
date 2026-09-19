'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexSessionMonitor, _internals } = require('../src/session-monitor');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-session-monitor-'));
const day = path.join(root, '2026', '09', '19');
fs.mkdirSync(day, { recursive: true });

const iso = offset => new Date(1789813128000 + offset).toISOString();
const meta = (id, overrides = {}) => ({
  timestamp: iso(0), type: 'session_meta', payload: {
    id, originator: 'Codex Desktop', source: 'vscode', thread_source: 'user',
    cwd: 'C:\\work\\demo', model_provider: 'openai', ...overrides,
  },
});
const event = (offset, payload) => ({ timestamp: iso(offset), type: 'event_msg', payload });
const response = (offset, payload) => ({ timestamp: iso(offset), type: 'response_item', payload });
const writeLines = (filePath, rows, trailing = true) => fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + (trailing ? '\n' : ''), 'utf8');

const threadId = 'thread-root';
const turnId = 'turn-1';
const first = path.join(day, 'root-a.jsonl');
writeLines(first, [
  meta(threadId),
  event(1000, { type: 'task_started', turn_id: turnId, started_at: 1789813129 }),
  response(1200, {
    type: 'message', role: 'user',
    content: [{ type: 'input_text', text: 'PLEASE IMPLEMENT THIS PLAN:\n# 修复铃铛与实时任务' }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  }),
  event(2000, {
    type: 'item_completed', turn_id: turnId,
    item: { type: 'CommandExecution', command: ['pwsh.exe', '-Command', 'npm test --token=secret-value'] },
  }),
]);

const guardian = path.join(day, 'guardian.jsonl');
writeLines(guardian, [
  meta('guardian', { source: { subagent: {} }, thread_source: 'guardian_review' }),
  event(1000, { type: 'task_started', turn_id: 'review-turn', started_at: 1789813129 }),
]);

let changes = 0;
const monitor = new CodexSessionMonitor({ sessionsRoot: root, onChange: () => { changes++; }, pollIntervalMs: 60000, staleMs: 1e12 });
monitor.scan(true);
let tasks = monitor.snapshot();
assert.equal(tasks.length, 1);
assert.equal(tasks[0].threadId, threadId);
assert.equal(tasks[0].brief, '修复铃铛与实时任务');
assert.match(tasks[0].progress, /命令已完成/);
assert.doesNotMatch(tasks[0].progress, /secret-value/);

const partial = JSON.stringify(event(3000, {
  type: 'item_completed', turn_id: turnId,
  item: { type: 'FileChange', changes: { 'C:\\work\\demo\\src\\app.js': { type: 'update' } } },
}));
fs.appendFileSync(first, partial.slice(0, 60), 'utf8');
monitor.scan(false);
assert.match(monitor.snapshot()[0].progress, /命令已完成/);
fs.appendFileSync(first, partial.slice(60) + '\n', 'utf8');
monitor.scan(false);
assert.equal(monitor.snapshot()[0].progress, '已更新文件 · src\\app.js');

const continuation = path.join(day, 'root-b.jsonl');
writeLines(continuation, [
  meta(threadId),
  event(4000, { type: 'task_complete', turn_id: turnId, completed_at: 1789813132, last_agent_message: '完成，密钥 sk-1234567890abcdefghijkl 不应显示' }),
]);
monitor.scan(false);
tasks = monitor.snapshot();
assert.equal(tasks.length, 1);
assert.equal(tasks[0].status, 'done');
assert.doesNotMatch(tasks[0].progress, /1234567890abcdefghijkl/);
assert.ok(changes >= 3);

assert.equal(_internals.sessionMetaAccepted(meta('ok').payload), true);
assert.equal(_internals.sessionMetaAccepted(meta('bad', { thread_source: 'subagent' }).payload), false);
assert.equal(_internals.sessionMetaAccepted(meta('work', { originator: 'codex_work_desktop' }).payload), true);
assert.equal(_internals.sessionMetaAccepted(meta('quick', { thread_source: 'avatar_quick_chat' }).payload), true);
assert.equal(_internals.sessionMetaAccepted(meta('ide', { originator: 'codex_vscode' }).payload), true);
assert.equal(_internals.sessionMetaAccepted(meta('cli', { originator: 'codex-tui', source: 'cli' }).payload), true);
assert.equal(_internals.sessionMetaAccepted(meta('exec', { source: 'exec' }).payload), false);
assert.equal(_internals.sessionMetaAccepted(meta('pet', { originator: 'pet-office', thread_source: null }).payload), false);
assert.equal(_internals.surfaceLabel(meta('work', { originator: 'codex_work_desktop' }).payload), 'Work 桌面端');
assert.equal(_internals.surfaceLabel(meta('quick', { thread_source: 'avatar_quick_chat' }).payload), '快速对话');
assert.equal(_internals.surfaceLabel(meta('ide', { originator: 'codex_vscode' }).payload), 'IDE 扩展');
assert.equal(_internals.surfaceLabel(meta('cli', { originator: 'codex-tui', source: 'cli' }).payload), 'CLI 会话');
assert.equal(_internals.isControlMessage('<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>'), true);
assert.equal(_internals.isControlMessage('正常用户消息'), false);
assert.doesNotMatch(_internals.redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /abcdefghijklmnopqrstuvwxyz/);

const turn2 = 'turn-2';
fs.appendFileSync(first, JSON.stringify(event(5000, { type: 'task_started', turn_id: turn2, started_at: 1789813133 })) + '\n', 'utf8');
fs.appendFileSync(first, JSON.stringify(response(5100, {
  type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second question' }],
  internal_chat_message_metadata_passthrough: { turn_id: turn2 },
})) + '\n', 'utf8');
monitor.scan(false);
tasks = monitor.snapshot();
assert.equal(tasks.find(item => item.turnId === turn2).status, 'running');
assert.equal(tasks.find(item => item.turnId === turn2).brief, 'Second question');
assert.equal(tasks.find(item => item.turnId === turnId).status, 'done');

fs.appendFileSync(first, JSON.stringify(event(4500, {
  type: 'item_completed', turn_id: turnId, item: { type: 'CommandExecution', command: 'echo stale' },
})) + '\n', 'utf8');
monitor.scan(false);
assert.equal(monitor.snapshot().find(item => item.turnId === turnId).status, 'done');

// 中断优先：迟到的 task_complete 不得把已中断回合改成完成。
const turn3 = 'turn-3';
fs.appendFileSync(first, JSON.stringify(event(7000, { type: 'task_started', turn_id: turn3, started_at: 1789813141 })) + '\n', 'utf8');
fs.appendFileSync(first, JSON.stringify(event(7100, { type: 'turn_aborted', turn_id: turn3, reason: 'interrupted', completed_at: 1789813142 })) + '\n', 'utf8');
fs.appendFileSync(first, JSON.stringify(event(7200, { type: 'task_complete', turn_id: turn3, completed_at: 1789813143, last_agent_message: 'late complete' })) + '\n', 'utf8');
monitor.scan(false);
assert.equal(monitor.snapshot().find(item => item.turnId === turn3).status, 'cancelled');

// 会话文件创建瞬间第一行未写完时，必须重试而不是永久拒绝。
const raceFile = path.join(day, 'race.jsonl');
const raceMetaLine = JSON.stringify(meta('race-thread'));
fs.writeFileSync(raceFile, raceMetaLine.slice(0, 40), 'utf8');
monitor.scan(false);
assert.ok(!monitor.snapshot().some(item => item.threadId === 'race-thread'));
fs.appendFileSync(raceFile, raceMetaLine.slice(40) + '\n', 'utf8');
fs.appendFileSync(raceFile, JSON.stringify(event(6000, { type: 'task_started', turn_id: 'race-turn', started_at: 1789813140 })) + '\n', 'utf8');
monitor.scan(false);
const raceTask = monitor.snapshot().find(item => item.threadId === 'race-thread');
assert.ok(raceTask);
assert.equal(raceTask.status, 'running');
assert.equal(raceTask.surface, 'Codex 桌面端');
assert.equal(raceTask.petName, 'Codex');

monitor.stop();
fs.rmSync(root, { recursive: true, force: true });
console.log('session monitor: aggregation, all surfaces, meta race retry, partial lines, lifecycle, turn superseding and redaction OK');
