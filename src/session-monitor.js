'use strict';

const fs = require('fs');
const path = require('path');

const ACTIVE_STATUSES = new Set(['running', 'queued', 'waiting_input']);
const DEFAULT_MAX_INITIAL_BYTES = 24 * 1024 * 1024;
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function oneLine(value, limit = 220) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function redact(value, limit = 220) {
  let text = String(value == null ? '' : value);
  text = text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-…已隐藏')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1…已隐藏')
    .replace(/\b(api[_ -]?key|access[_ -]?token|token|auth(?:orization)?|password|passwd|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=…已隐藏')
    .replace(/([?&](?:key|token|secret|password)=)[^&#\s]+/gi, '$1…已隐藏');
  return oneLine(text, limit);
}

function eventTime(record, fallback = Date.now()) {
  const parsed = Date.parse(record && record.timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function secondsToMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1000 : fallback;
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(part => part && (part.text || part.input_text || part.output_text || '')).filter(Boolean).join(' ');
}

function taskBrief(value) {
  const lines = String(value == null ? '' : value)
    .split(/\r?\n/)
    .map(line => redact(line, 180).replace(/^#+\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) return '正在处理 Codex 任务';
  if (/^please implement this plan:?$/i.test(lines[0]) && lines[1]) return oneLine(lines[1], 110);
  if (/^# files mentioned by the user/i.test(lines[0])) {
    const request = lines.find(line => !/^#|^##|^[-*]\s/.test(line) && !/files mentioned/i.test(line));
    if (request) return oneLine(request, 110);
  }
  return oneLine(lines[0], 110);
}

function isControlMessage(value) {
  // 中断/压缩等操作会写入形如 <turn_aborted>…</turn_aborted> 的合成消息，
  // 它们不是用户输入，不能用作任务摘要。
  return /^<[a-z][a-z_.]*>[\s\S]*<\/[a-z][a-z_.]*>$/i.test(String(value || '').trim());
}

function displayPath(filePath, cwd) {
  const raw = String(filePath || '');
  if (!raw) return '';
  try {
    if (cwd) {
      const relative = path.relative(cwd, raw);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    }
  } catch {}
  return path.basename(raw) || raw;
}

function displayCommand(command) {
  let parts = Array.isArray(command) ? command.map(String) : [String(command || '')];
  if (parts.length >= 3 && /(?:powershell|pwsh)(?:\.exe)?$/i.test(parts[0]) && /^-(?:command|c)$/i.test(parts[1])) parts = parts.slice(2);
  if (parts.length >= 3 && /cmd(?:\.exe)?$/i.test(parts[0]) && /^\/c$/i.test(parts[1])) parts = parts.slice(2);
  return redact(parts.join(' '), 180);
}

function sessionMetaAccepted(meta) {
  if (!meta || !meta.id) return false;
  const originator = String(meta.originator || '');
  if (!originator || originator === 'pet-office') return false;
  const source = meta.source;
  if (typeof source !== 'string' || !source || source === 'exec') return false;
  const threadSource = meta.thread_source;
  return threadSource === 'user' || threadSource === 'avatar_quick_chat';
}

function surfaceLabel(meta) {
  const originator = String((meta && meta.originator) || '');
  if ((meta && meta.thread_source) === 'avatar_quick_chat') return '快速对话';
  if (originator === 'codex_work_desktop') return 'Work 桌面端';
  if (originator === 'codex_vscode') return 'IDE 扩展';
  if (originator === 'codex-tui') return 'CLI 会话';
  return 'Codex 桌面端';
}

function taskKey(threadId, turnId) {
  return 'desktop:' + threadId + ':' + turnId;
}

class CodexSessionMonitor {
  constructor(options = {}) {
    this.sessionsRoot = options.sessionsRoot;
    this.pollIntervalMs = options.pollIntervalMs || 5000;
    this.staleMs = options.staleMs || DEFAULT_STALE_MS;
    this.maxInitialBytes = options.maxInitialBytes || DEFAULT_MAX_INITIAL_BYTES;
    this.maxFiles = options.maxFiles || 160;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.files = new Map();
    this.tasks = new Map();
    this.threadNewest = new Map();
    this.pendingCalls = new Map();
    this.watcher = null;
    this.pollTimer = null;
    this.scanTimer = null;
    this.started = false;
    this.healthState = { ok: true, error: null, lastScanAt: 0 };
    this.lastSnapshotSignature = '';
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.scan(true);
    this._startWatcher();
    this.pollTimer = setInterval(() => this.scan(false), this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stop() {
    this.started = false;
    clearTimeout(this.scanTimer);
    clearInterval(this.pollTimer);
    this.scanTimer = null;
    this.pollTimer = null;
    try { if (this.watcher) this.watcher.close(); } catch {}
    this.watcher = null;
  }

  health() {
    return { ...this.healthState };
  }

  snapshot(excludedThreadIds = new Set()) {
    const now = Date.now();
    const output = [];
    for (const task of this.tasks.values()) {
      if (excludedThreadIds.has(task.threadId)) continue;
      const copy = { ...task };
      if (ACTIVE_STATUSES.has(copy.status) && now - (copy.updatedAt || copy.startedAt || 0) > this.staleMs) {
        copy.status = 'unknown';
        copy.progressStage = 'warning';
        copy.progress = '长时间无新进度，请在 Codex 中确认';
      }
      output.push(copy);
    }
    return output
      .sort((a, b) => (a.updatedAt || a.startedAt || 0) - (b.updatedAt || b.startedAt || 0))
      .slice(-60);
  }

  scheduleScan() {
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scan(false), 120);
  }

  scan(initial = false) {
    if (!this.sessionsRoot) return;
    try {
      if (!fs.existsSync(this.sessionsRoot)) throw new Error('未找到 Codex 会话目录');
      const files = this._discoverFiles(initial);
      for (const filePath of files) this._readFile(filePath);
      this._pruneTasks();
      this.healthState = { ok: true, error: null, lastScanAt: Date.now() };
      this._emitIfChanged();
    } catch (error) {
      this.healthState = { ok: false, error: oneLine(error.message || error, 180), lastScanAt: Date.now() };
      this.log('session monitor scan failed: ' + this.healthState.error);
      this._emitIfChanged();
    }
  }

  _startWatcher() {
    try {
      this.watcher = fs.watch(this.sessionsRoot, { persistent: false, recursive: true }, (_event, fileName) => {
        if (!fileName || String(fileName).toLowerCase().endsWith('.jsonl')) this.scheduleScan();
      });
      this.watcher.on('error', error => {
        this.log('session monitor watch failed: ' + error.message);
        this.healthState = { ok: false, error: '实时监听中断，已改用轮询', lastScanAt: Date.now() };
        this._emitIfChanged();
      });
    } catch (error) {
      this.log('session monitor watch unavailable: ' + error.message);
      this.watcher = null;
    }
  }

  _discoverFiles(initial) {
    const candidates = [];
    const visit = dir => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(fullPath);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(fullPath);
            if (initial || this.files.has(fullPath) || Date.now() - stat.mtimeMs < 3 * 24 * 60 * 60 * 1000) {
              candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
            }
          } catch {}
        }
      }
    };
    visit(this.sessionsRoot);
    return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.maxFiles).map(item => item.path);
  }

  _readFirstRecord(filePath) {
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(128 * 1024);
      const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, length).toString('utf8');
      const newlineIndex = text.indexOf('\n');
      if (newlineIndex < 0) return { ok: false };
      const firstLine = text.slice(0, newlineIndex).trim();
      if (!firstLine) return { ok: false };
      try {
        return { ok: true, record: JSON.parse(firstLine) };
      } catch {
        return { ok: true, record: null };
      }
    } catch {
      return { ok: false };
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    }
  }

  _pruneTasks() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, task] of this.tasks) {
      if ((task.updatedAt || task.startedAt || 0) < cutoff) this.tasks.delete(id);
    }
  }

  _readFile(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    let file = this.files.get(filePath);
    if (!file) {
      file = {
        offset: stat.size,
        remainder: '',
        meta: null,
        accepted: false,
        metaChecked: false,
        skipLeadingFragment: false,
      };
      this.files.set(filePath, file);
    }
    if (!file.metaChecked) {
      const first = this._readFirstRecord(filePath);
      if (!first.ok) {
        // 会话文件刚创建、第一行尚未写完：下次扫描重试，而不是永久拒绝。
        file.offset = stat.size;
        file.remainder = '';
        return;
      }
      file.metaChecked = true;
      file.meta = first.record && first.record.type === 'session_meta' ? first.record.payload : null;
      file.accepted = sessionMetaAccepted(file.meta);
      if (file.accepted) {
        const recent = Date.now() - stat.mtimeMs < 5 * 60 * 1000;
        const initialCap = recent ? this.maxInitialBytes : Math.min(this.maxInitialBytes, 256 * 1024);
        file.offset = Math.max(0, stat.size - initialCap);
        file.skipLeadingFragment = file.offset > 0;
      }
    }
    if (!file.accepted) {
      file.offset = stat.size;
      file.remainder = '';
      return;
    }
    if (stat.size < file.offset) {
      file.offset = 0;
      file.remainder = '';
      file.skipLeadingFragment = false;
    }
    if (stat.size === file.offset) return;
    const start = file.offset;
    const length = stat.size - start;
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      if (file.skipLeadingFragment) {
        const firstBreak = text.indexOf('\n');
        text = firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
        file.skipLeadingFragment = false;
      }
      const complete = file.remainder + text;
      const lines = complete.split(/\r?\n/);
      file.remainder = lines.pop() || '';
      file.offset = start + bytesRead;
      for (const line of lines) {
        if (!line || line.length > 32 * 1024 * 1024) continue;
        try { this._consume(JSON.parse(line), file.meta); } catch {}
      }
    } catch (error) {
      this.log('session monitor read failed: ' + path.basename(filePath) + ': ' + error.message);
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    }
  }

  _ensureTask(meta, turnId, timestamp) {
    if (!turnId) return null;
    const id = taskKey(meta.id, turnId);
    const newest = this.threadNewest.get(meta.id);
    if (!newest || timestamp >= newest.at) this.threadNewest.set(meta.id, { turnId, at: timestamp });
    const superseded = !!(newest && newest.turnId !== turnId && timestamp < newest.at);
    let task = this.tasks.get(id);
    if (!task) {
      task = {
        id,
        source: 'desktop',
        threadId: meta.id,
        turnId,
        petId: 'supervisor',
        petName: 'Codex',
        surface: surfaceLabel(meta),
        model: meta.model_provider || null,
        cwd: meta.cwd || '',
        projectName: meta.cwd ? path.basename(meta.cwd) : 'Codex Desktop',
        brief: '正在处理 Codex 任务',
        progress: '正在分析任务…',
        progressStage: 'thinking',
        status: superseded ? 'done' : 'running',
        startedAt: timestamp,
        updatedAt: timestamp,
      };
      this.tasks.set(id, task);
      if (!superseded) this._supersedeOlderTurns(meta.id, turnId, timestamp);
    }
    task.lastEventAt = Math.max(task.lastEventAt || 0, timestamp);
    return task;
  }

  _supersedeOlderTurns(threadId, turnId, timestamp) {
    for (const task of this.tasks.values()) {
      if (task.threadId !== threadId || task.turnId === turnId) continue;
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      if ((task.lastEventAt || task.startedAt || 0) >= timestamp) continue;
      task.status = 'done';
      task.updatedAt = Math.max(task.updatedAt || 0, timestamp);
    }
  }

  _isSupersededEvent(threadId, turnId, timestamp) {
    const newest = this.threadNewest.get(threadId);
    return !!(newest && newest.turnId !== turnId && timestamp < newest.at);
  }

  _taskForRecord(meta, payload, record) {
    const turnId = payload && (payload.turn_id || payload.turnId || (payload.internal_chat_message_metadata_passthrough && payload.internal_chat_message_metadata_passthrough.turn_id));
    return this._ensureTask(meta, turnId, eventTime(record));
  }

  _consume(record, meta) {
    if (!record || !meta || !sessionMetaAccepted(meta)) return;
    const payload = record.payload || {};
    const timestamp = eventTime(record);

    if (record.type === 'turn_context') {
      const task = this._taskForRecord(meta, payload, record);
      if (task) {
        task.model = payload.model || payload.model_provider || task.model;
        task.cwd = payload.cwd || task.cwd;
        task.projectName = task.cwd ? path.basename(task.cwd) : task.projectName;
        task.updatedAt = Math.max(task.updatedAt || 0, timestamp);
      }
      return;
    }

    if (record.type === 'event_msg') {
      const type = String(payload.type || '');
      if (type === 'task_started') {
        const task = this._taskForRecord(meta, payload, record);
        if (task) {
          task.status = this._isSupersededEvent(meta.id, task.turnId, timestamp) ? 'done' : 'running';
          task.startedAt = secondsToMs(payload.started_at, timestamp);
          task.updatedAt = timestamp;
          task.progressStage = 'thinking';
          task.progress = '正在分析任务…';
        }
        return;
      }
      if (type === 'task_complete') {
        const task = this._taskForRecord(meta, payload, record);
        if (task) {
          if (task.status === 'cancelled') return;
          // 中断结果优先：迟到的完成记录不得把已中断回合改成完成。
          task.status = 'done';
          task.updatedAt = secondsToMs(payload.completed_at, timestamp);
          task.progressStage = 'report';
          task.progress = redact(payload.last_agent_message || '任务已完成', 220);
        }
        return;
      }
      if (type === 'turn_aborted') {
        const task = this._taskForRecord(meta, payload, record);
        if (task) {
          task.status = 'cancelled';
          task.updatedAt = secondsToMs(payload.completed_at, timestamp);
          task.progressStage = 'warning';
          task.progress = payload.reason === 'interrupted' ? '任务已中断' : '任务已停止';
        }
        return;
      }
      if (type === 'item_started' || type === 'item_completed') {
        this._consumeCompletedItem(this._taskForRecord(meta, payload, record), payload.item, timestamp, type === 'item_completed');
      }
      return;
    }

    if (record.type !== 'response_item') return;
    const turnId = payload.internal_chat_message_metadata_passthrough && payload.internal_chat_message_metadata_passthrough.turn_id;
    const task = this._ensureTask(meta, turnId, timestamp);
    if (!task) return;
    if (payload.type === 'message' && payload.role === 'user') {
      const message = contentText(payload.content);
      if (!isControlMessage(message)) task.brief = taskBrief(message);
      task.updatedAt = Math.max(task.updatedAt || 0, timestamp);
      return;
    }
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = redact(contentText(payload.content), 220);
      if (text) {
        task.progressStage = 'report';
        task.progress = text;
        task.updatedAt = timestamp;
      }
      return;
    }
    if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
      const name = String(payload.name || '').toLowerCase();
      const waiting = /request_user_input|request_permissions|approval/.test(name);
      if (payload.call_id) this.pendingCalls.set(payload.call_id, { taskId: task.id, waiting });
      const supersededEvent = this._isSupersededEvent(meta.id, task.turnId, timestamp);
      task.status = supersededEvent ? 'done' : (waiting ? 'waiting_input' : 'running');
      task.updatedAt = timestamp;
      if (waiting) {
        task.progressStage = 'waiting';
        task.progress = '等待你在 Codex 中确认或回答';
      } else if (/apply_patch|file|write/.test(name)) {
        task.progressStage = 'file';
        task.progress = '正在更新项目文件';
      } else if (/exec|command|shell/.test(name)) {
        task.progressStage = 'command';
        task.progress = '正在运行命令';
      } else {
        task.progressStage = 'tool';
        task.progress = '正在调用工具' + (name ? ' · ' + redact(name, 80) : '');
      }
      return;
    }
    if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
      const pending = this.pendingCalls.get(payload.call_id);
      if (pending && pending.taskId === task.id) {
        this.pendingCalls.delete(payload.call_id);
        if (pending.waiting && task.status === 'waiting_input') {
          task.status = 'running';
          task.progressStage = 'thinking';
          task.progress = '已收到输入，继续处理…';
          task.updatedAt = timestamp;
        }
      }
    }
  }

  _consumeCompletedItem(task, item, timestamp, completed = true) {
    if (!task || !item) return;
    const type = String(item.type || '').toLowerCase();
    task.status = this._isSupersededEvent(task.threadId, task.turnId, timestamp)
      ? 'done'
      : (task.status === 'waiting_input' ? task.status : 'running');
    task.updatedAt = timestamp;
    if (type.includes('command')) {
      const command = displayCommand(item.command || item.commandLine || item.cmd);
      task.progressStage = 'command';
      task.progress = (completed ? '命令已完成' : '正在运行命令') + (command ? ' · ' + command : '');
      return;
    }
    if (type.includes('file') || type.includes('patch')) {
      const paths = item.changes && typeof item.changes === 'object' ? Object.keys(item.changes) : [];
      const target = displayPath(paths[0] || item.path || item.filePath, task.cwd);
      task.progressStage = 'file';
      task.progress = (completed ? '已更新文件' : '正在修改文件') + (target ? ' · ' + target : '');
      return;
    }
    if (type.includes('agentmessage') || type.includes('agent_message')) {
      const message = redact(contentText(item.content) || item.text || item.message, 220);
      if (message) {
        task.progressStage = 'report';
        task.progress = message;
      }
      return;
    }
    if (type.includes('reason')) {
      task.progressStage = 'thinking';
      task.progress = '正在梳理方案与核验结果…';
    }
  }

  _emitIfChanged() {
    const payload = { tasks: this.snapshot(), monitor: this.health() };
    const signature = JSON.stringify(payload);
    if (signature === this.lastSnapshotSignature) return;
    this.lastSnapshotSignature = signature;
    try { this.onChange(payload); } catch (error) { this.log('session monitor callback failed: ' + error.message); }
  }
}

module.exports = {
  CodexSessionMonitor,
  _internals: { oneLine, redact, taskBrief, isControlMessage, displayCommand, displayPath, sessionMetaAccepted, surfaceLabel, taskKey },
};
