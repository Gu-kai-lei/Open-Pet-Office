'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { _internals: { redact } } = require('./session-monitor');
const { log, CODEX_HOME } = require('./config');
const { httpProviderArgs } = require('./codex-transport');

const running = new Map();
let queue = [];
let activeCount = 0;
let maxParallel = 5;
let emit = () => {};

function setConcurrency(n) { maxParallel = Math.max(1, n | 0 || 5); pump(); }
function setEmitter(fn) { emit = fn; }

function ensureProjectDirs(projectDir) {
  for (const sub of ['tasks', 'messages']) fs.mkdirSync(path.join(projectDir, sub), { recursive: true });
  const hive = path.join(projectDir, 'HIVE.md');
  if (!fs.existsSync(hive)) fs.writeFileSync(hive, '# Hive Board\n\n_共享计划与约定。每个 agent 开始任务前先读这里，完成后把对团队有用的结论追加到 MEMORY.md。_\n', 'utf8');
  const mem = path.join(projectDir, 'MEMORY.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, '# MEMORY\n\n_团队共享记忆：重要结论、约定、进度。按时间倒序追加，一行一条。_\n', 'utf8');
}

function startTask(task) {
  queue.push(task);
  emit({ type: 'queued', taskId: task.id });
  pump();
  return task.id;
}

function pump() {
  while (activeCount < maxParallel && queue.length) {
    const t = queue.shift();
    activeCount++;
    run(t).finally(() => { activeCount--; pump(); });
  }
}

function run(t) {
  return new Promise(resolve => {
    try {
      if (!t.skipLegacyDirs) ensureProjectDirs(t.projectDir);
      else fs.mkdirSync(t.projectDir, { recursive: true });
    } catch (e) {
      emit({ type: 'failed', taskId: t.id, exitCode: -1, error: '项目目录创建失败: ' + e.message });
      return resolve();
    }
    const briefPath = t.briefPath || path.join(t.projectDir, 'tasks', t.id + '.brief.md');
    const outPath = t.resultPath || path.join(t.projectDir, 'tasks', t.id + '.result.md');
    const brief = t.missionId
      ? (t.brief || '(无简报)') + '\n\n---\nMission 工作约定：\n- 只能在当前隔离工作区内工作。\n- 不要修改 .pet-office 目录。\n- 遵守简报中的文件范围、交付物和验证要求。\n- 最终输出必须符合系统提供的 JSON Schema。\n'
      : (t.brief || '(无简报)') + '\n\n---\n工作约定：\n- 先读 HIVE.md 与 MEMORY.md，遵守其中约定。\n- 需要修改项目时直接在共享工作区完成。\n- 最终回复必须包含完整结果或工作报告；系统会自动保存为 tasks/' + t.id + '.result.md。\n- 有对团队有用的结论时，追加到 MEMORY.md。\n';
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    try { fs.writeFileSync(briefPath, brief, 'utf8'); } catch (e) {
      emit({ type: 'failed', taskId: t.id, exitCode: -1, error: '简报写入失败: ' + e.message });
      return resolve();
    }
    const prompt = t.prompt || ('Read ' + JSON.stringify(briefPath) + ' and complete the task it describes. Make any requested workspace changes, then put the complete result or work report in your final response. Do not reply with only DONE; the final response is automatically saved as the result file.');
    const args = ['/d', '/s', '/c', 'codex', 'exec', ...httpProviderArgs(), '--json', '--skip-git-repo-check', '-C', t.projectDir, '--sandbox', 'workspace-write', '-o', outPath];
    if (t.threadSource) args.push('--thread-source', t.threadSource);
    if (t.outputSchemaPath) args.push('--output-schema', t.outputSchemaPath);
    if (t.model) args.push('-m', t.model);
    // Pipe the prompt via stdin: cmd.exe cuts command-line arguments at the
    // first newline, which silently truncated any multi-line task prompt.
    args.push('-');
    emit({ type: 'started', taskId: t.id, model: t.model || '(codex默认)' });
    const startedAt = Date.now();
    let child;
    try {
      child = spawn('cmd.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
    } catch (e) {
      emit({ type: 'failed', taskId: t.id, exitCode: -1, error: '无法启动 codex: ' + e.message });
      return resolve();
    }
    const runtime = { child, meta: t, cancelled: false };
    running.set(t.id, runtime);
    let buf = '';
    let eventError = '';
    let stderrTail = '';
    let latestTokens = 0;
    let latestProgress = '';
    const onLine = line => {
      line = line.trim();
      if (!line.startsWith('{')) return;
      try {
        const obj = JSON.parse(line);
        const type = String(obj.type || obj.method || '').toLowerCase();
        const item = obj.item || (obj.params && obj.params.item) || {};
        if (type === 'error' && obj.message) eventError = String(obj.message);
        else if ((type.includes('turn.failed') || type.includes('turn/failed')) && obj.error) eventError = String(obj.error.message || obj.error);
        else if (String(item.type || '').toLowerCase() === 'error' && item.message) eventError = String(item.message);
        const tid = obj.thread_id || obj.session_id || (obj.thread && obj.thread.id) || (obj.msg && (obj.msg.id || obj.msg.thread_id));
        if (tid && !t.threadId) { t.threadId = tid; emit({ type: 'session', taskId: t.id, threadId: tid }); }
        const usage = findTotalTokens(obj);
        if (typeof usage === 'number' && usage > latestTokens) {
          latestTokens = usage;
          emit({ type: 'usage', taskId: t.id, tokens: usage });
        }
        const progress = progressFromEvent(obj);
        if (progress && progress.text !== latestProgress) {
          latestProgress = progress.text;
          emit({ type: 'progress', taskId: t.id, stage: progress.stage, text: progress.text });
        }
      } catch {}
    };
    child.stdout.on('data', d => { buf += d.toString(); const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
    child.stderr.on('data', d => {
      const s = d.toString().trim();
      if (!s) return;
      stderrTail = (stderrTail + '\n' + s).slice(-4000);
      emit({ type: 'log', taskId: t.id, text: s.slice(0, 400) });
    });
    child.on('exit', code => {
      running.delete(t.id);
      if (!runtime.cancelled) {
        if (buf.trim()) onLine(buf);
        const sessionTokens = readSessionTokens(t.threadId, startedAt);
        if (sessionTokens > latestTokens) {
          latestTokens = sessionTokens;
          emit({ type: 'usage', taskId: t.id, tokens: sessionTokens });
        }
        emit({
          type: code === 0 ? 'done' : 'failed', taskId: t.id, exitCode: code,
          error: code === 0 ? undefined : (oneLine(eventError, 1200) || oneLine(stderrTail, 1200) || ('Codex exit ' + code)),
          elapsedMs: Date.now() - startedAt, resultPath: outPath,
        });
      }
      resolve();
    });
    child.on('error', e => {
      running.delete(t.id);
      if (!runtime.cancelled) emit({ type: 'failed', taskId: t.id, exitCode: -1, error: e.message });
      resolve();
    });
  });
}

function oneLine(value, limit = 240) {
  return redact(value, limit);
}

function progressFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const type = String(obj.type || obj.method || '').toLowerCase();
  const item = obj.item || (obj.params && obj.params.item) || obj.msg || {};
  const itemType = String(item.type || item.kind || '').toLowerCase();
  if (type.includes('turn.started') || type.includes('turn/started')) return { stage: 'thinking', text: '正在分析任务' };
  if (itemType.includes('command')) {
    const command = oneLine(item.command || item.cmd || item.arguments || item.input || '', 180);
    if (type.includes('started')) return { stage: 'command', text: command ? '运行命令 · ' + command : '正在运行命令' };
    if (type.includes('completed')) return { stage: 'command', text: command ? '命令完成 · ' + command : '命令执行完成' };
  }
  if (itemType.includes('file') || itemType.includes('patch')) {
    const target = oneLine(item.path || item.file_path || item.filePath || item.summary || '', 180);
    return { stage: 'file', text: target ? '更新文件 · ' + target : '正在更新项目文件' };
  }
  if (itemType.includes('agent_message') || itemType === 'message') {
    const message = oneLine(item.text || item.content || item.message || '', 220);
    if (message) return { stage: 'report', text: message };
  }
  if (itemType.includes('reasoning')) return { stage: 'thinking', text: '正在梳理方案与核验结果' };
  if (type.includes('turn.completed') || type.includes('turn/completed')) return { stage: 'finishing', text: '正在整理最终结果' };
  return null;
}

function findTotalTokens(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  const preferred = [
    obj.thread_token_usage,
    obj.turn_token_usage,
    obj.total_token_usage,
    obj.info && obj.info.total_token_usage,
    obj.usage,
  ];
  for (const usage of preferred) {
    if (usage && typeof usage.total_tokens === 'number') return usage.total_tokens;
  }
  if (typeof obj.total_tokens === 'number') return obj.total_tokens;
  for (const k of Object.keys(obj)) {
    const v = findTotalTokens(obj[k], depth + 1);
    if (typeof v === 'number') return v;
  }
  return null;
}

function readSessionTokens(threadId, startedAt) {
  if (!threadId) return 0;
  const dayDirs = new Set();
  for (const delta of [-86400000, 0, 86400000]) {
    const d = new Date(startedAt + delta);
    dayDirs.add(path.join(CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
    dayDirs.add(path.join(CODEX_HOME, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')));
  }
  for (const dir of dayDirs) {
    try {
      const name = fs.readdirSync(dir).find(x => x.includes(threadId) && x.endsWith('.jsonl'));
      if (!name) continue;
      const lines = fs.readFileSync(path.join(dir, name), 'utf8').trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('token')) continue;
        try {
          const value = findTotalTokens(JSON.parse(lines[i]));
          if (typeof value === 'number' && value > 0) return value;
        } catch {}
      }
    } catch {}
  }
  return 0;
}

function cancel(taskId) {
  const r = running.get(taskId);
  if (!r) {
    queue = queue.filter(t => t.id !== taskId);
    emit({ type: 'cancelled', taskId });
    return true;
  }
  stopProcessTree(r);
  emit({ type: 'cancelled', taskId });
  return true;
}

function stopProcessTree(runtime) {
  if (!runtime || !runtime.child) return;
  runtime.cancelled = true;
  if (process.platform === 'win32' && runtime.child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(runtime.child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', error => {
        log('taskkill: ' + error.message);
        try { runtime.child.kill(); } catch {}
      });
      if (killer.unref) killer.unref();
      return;
    } catch (error) { log('shutdown taskkill: ' + error.message); }
  }
  try { runtime.child.kill(); } catch {}
}

function shutdown() {
  const queued = queue;
  queue = [];
  for (const task of queued) emit({ type: 'cancelled', taskId: task.id, reason: 'app-exit' });
  for (const runtime of running.values()) stopProcessTree(runtime);
  running.clear();
}

function snapshot() {
  return { active: [...running.keys()], queued: queue.map(t => t.id), activeCount };
}

module.exports = {
  startTask,
  cancel,
  shutdown,
  setConcurrency,
  setEmitter,
  ensureProjectDirs,
  snapshot,
  _internals: { findTotalTokens, readSessionTokens, progressFromEvent, oneLine },
};
