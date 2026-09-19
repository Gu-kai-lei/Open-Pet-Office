'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog, shell, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const cfg = require('./config');
const catalog = require('./catalog');
const quota = require('./quota');
const dispatcher = require('./dispatcher');
const planner = require('./planner');
const bridge = require('./bridge');
const { AppServerClient } = require('./appserver');
const { CodexSessionMonitor } = require('./session-monitor');
const inbox = require('./inbox');

cfg.ensureDirs();

let win = null;
let tray = null;
let isQuitting = false;
let state = cfg.loadState();
let quotaCache = { ok: false, reports: [], error: null };
let skinCache = { at: 0, items: [] };
const spriteDataCache = new Map();
let batchSeq = 0;
const batches = new Map();
const petSessionTokens = new Map();
const appServer = new AppServerClient();
const petThreads = new Map(Object.entries(state.conversations || {}));
const loadedThreads = new Set();
const startingChats = new Set();
const liveChats = new Map();
const pendingInteractions = new Map();
let appServerIdleTimer = null;
let desktopMonitorHealth = { ok: true, error: null, lastScanAt: 0 };
const TOGGLE_SHORTCUTS = new Set(['Control+Alt+P', 'Super+Alt+P', 'Control+Shift+P', 'Alt+Shift+P']);
let shortcutStatus = { ok: true, active: state.settings.toggleShortcut || 'Control+Alt+P', fallback: false };

const desktopMonitor = new CodexSessionMonitor({
  sessionsRoot: path.join(cfg.CODEX_HOME, 'sessions'),
  log: cfg.log,
  onChange: payload => {
    desktopMonitorHealth = payload.monitor || desktopMonitorHealth;
    emitTaskSnapshot();
  },
});

appServer.onEvent(onAppServerEvent);

// A saved running state is not proof that a process survived an application restart.
for (const task of state.history || []) {
  if (!['running', 'queued', 'waiting_input'].includes(task.status)) continue;
  task.status = 'failed';
  task.progress = '应用已重启，执行连接已断开；请打开原任务检查结果后继续。';
  task.error = task.progress;
  task.finishedAt = Date.now();
}
cfg.saveState(state);

function send(ch, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); } catch {}
}

function publicState() {
  return {
    pets: state.pets,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    settings: state.settings,
    ui: state.ui,
    caps: state.caps,
    quotas: quotaCache,
    skins: loadPetdexSkins(),
    interactions: publicInteractions(),
    desktopMonitor: desktopMonitorHealth,
    shortcutStatus,
  };
}

function publicInteractions() {
  return [...pendingInteractions.values()].map(entry => ({
    id: entry.id,
    kind: entry.kind,
    method: entry.method,
    threadId: entry.threadId,
    turnId: entry.turnId,
    petId: entry.petId,
    taskId: entry.taskId,
    title: entry.title,
    reason: entry.reason,
    detail: entry.detail,
    questions: entry.questions || [],
    createdAt: entry.createdAt,
  }));
}

function loadPetdexSkins(force = false) {
  const now = Date.now();
  if (!force && now - skinCache.at < 10000) return skinCache.items;
  const items = [];
  try {
    for (const entry of fs.readdirSync(cfg.DIRS.petdexPets, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(cfg.DIRS.petdexPets, entry.name);
      const metaPath = path.join(dir, 'pet.json');
      if (!fs.existsSync(metaPath)) continue;
      let meta;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
      const files = fs.readdirSync(dir);
      const declared = meta.spritesheet || meta.spriteSheet || meta.sprite_sheet || meta.spritesheetPath;
      const spriteName = (declared && files.includes(path.basename(declared)) && path.basename(declared))
        || files.find(name => /^spritesheet\.(webp|png)$/i.test(name))
        || files.find(name => /\.(webp|png)$/i.test(name));
      if (!spriteName) continue;
      const spritePath = path.join(dir, spriteName);
      const size = nativeImage.createFromPath(spritePath).getSize();
      const frame = meta.frame || meta.frameSize || {};
      const frameWidth = Number(meta.frameWidth || meta.frame_width || frame.width || 192);
      const frameHeight = Number(meta.frameHeight || meta.frame_height || frame.height || 208);
      const columns = Math.max(1, Number(meta.columns || Math.round(size.width / frameWidth) || 8));
      const rows = Math.max(1, Number(meta.rows || Math.round(size.height / frameHeight) || 9));
      items.push({
        slug: meta.slug || meta.id || entry.name,
        name: meta.name || meta.displayName || entry.name,
        author: meta.author || meta.creator || '',
        assetUrl: pathToFileURL(spritePath).href,
        columns,
        rows,
        frameWidth,
        frameHeight,
        spritePath,
      });
    }
  } catch {}
  items.sort((a, b) => a.name.localeCompare(b.name));
  skinCache = { at: now, items };
  return items;
}

function spriteDataUrl(spritePath) {
  let signature = null;
  try {
    const stat = fs.statSync(spritePath);
    signature = stat.size + ':' + Math.round(stat.mtimeMs);
    if (spriteDataCache.has(signature)) return spriteDataCache.get(signature);
  } catch { return null; }
  try {
    const extension = path.extname(spritePath).slice(1).toLowerCase();
    const mime = extension === 'png' ? 'image/png' : 'image/webp';
    const url = 'data:' + mime + ';base64,' + fs.readFileSync(spritePath).toString('base64');
    spriteDataCache.set(signature, url);
    return url;
  } catch (error) {
    cfg.log('sprite data read failed: ' + error.message);
    return null;
  }
}

function petRoster() {
  return [
    { id: 'supervisor', role: 'supervisor', name: state.pets.supervisor.name, model: state.pets.supervisor.model },
    ...state.pets.workers.map(w => ({ id: w.id, role: 'worker', name: w.name, model: w.model })),
  ];
}

function safeName(s) {
  const n = String(s || 'project').replace(/[\\/:*?"<>|]/g, '-').trim();
  return (n || 'project').slice(0, 60);
}

function createProjectDir(name, explicitPath) {
  const p = explicitPath || path.join(cfg.DIRS.projectsRoot, safeName(name));
  fs.mkdirSync(p, { recursive: true });
  dispatcher.ensureProjectDirs(p);
  let proj = state.projects.find(x => path.resolve(x.path) === path.resolve(p));
  if (!proj) {
    proj = { id: 'p' + Date.now().toString(36), name: name || path.basename(p), path: p, threadIds: [] };
    state.projects.push(proj);
  }
  state.activeProjectId = proj.id;
  cfg.saveState(state);
  return proj;
}

function activeProject() {
  return state.projects.find(p => p.id === state.activeProjectId) || null;
}

function persistStandaloneTask(task) {
  if (!Array.isArray(state.history)) state.history = [];
  const index = state.history.findIndex(item => item.id === task.id);
  if (index >= 0) state.history[index] = { ...task };
  else state.history.push({ ...task });
  state.history = state.history.slice(-100);
  cfg.saveState(state);
  emitTaskSnapshot();
}

function chatForTask(taskId) {
  return [...liveChats.values()].find(chat => chat.task.id === taskId) || null;
}

function flushChatDelta(chat) {
  if (!chat || !chat.pendingDelta) return;
  const delta = chat.pendingDelta;
  chat.pendingDelta = '';
  chat.flushTimer = null;
  send('chat:event', {
    type: 'delta', taskId: chat.task.id, petId: chat.task.petId,
    threadId: chat.threadId, turnId: chat.turnId, delta,
  });
}

function appServerItemProgress(method, item) {
  if (!item || !/^item\/(started|completed)$/.test(method)) return null;
  const type = String(item.type || '').toLowerCase();
  const completed = method === 'item/completed';
  if (type.includes('command')) {
    const command = item.command || item.commandLine || item.cmd || '';
    return { stage: 'command', text: (completed ? '已完成命令' : '正在运行命令') + (command ? ' · ' + String(command).replace(/\s+/g, ' ').slice(0, 180) : '') };
  }
  if (type.includes('file') || type.includes('patch')) {
    const pathText = item.path || item.filePath || (Array.isArray(item.changes) && item.changes[0] && (item.changes[0].path || item.changes[0].filePath)) || '';
    return { stage: 'file', text: (completed ? '已更新文件' : '正在修改文件') + (pathText ? ' · ' + String(pathText).slice(0, 180) : '') };
  }
  if (type.includes('tool') || type.includes('mcp')) {
    const name = item.name || item.tool || item.server || '';
    return { stage: 'tool', text: (completed ? '工具调用完成' : '正在调用工具') + (name ? ' · ' + String(name).slice(0, 120) : '') };
  }
  if (type.includes('reason') || type.includes('analysis')) return { stage: 'thinking', text: completed ? '分析完成，准备下一步…' : '正在分析任务…' };
  return null;
}

function finishChat(chat, status, error) {
  if (!chat) return;
  clearTimeout(chat.flushTimer);
  flushChatDelta(chat);
  chat.task.status = status === 'completed' ? 'done' : (status === 'interrupted' ? 'cancelled' : 'failed');
  chat.task.elapsedMs = Date.now() - chat.startedAt;
  chat.task.output = chat.output.slice(-12000);
  if (error) chat.task.error = error;
  persistStandaloneTask(chat.task);
  petSessionTokens.set(chat.task.petId, (petSessionTokens.get(chat.task.petId) || 0) + (chat.task.tokens || 0));
  send('chat:event', {
    type: chat.task.status, taskId: chat.task.id, petId: chat.task.petId,
    threadId: chat.threadId, turnId: chat.turnId,
    text: chat.output, error: chat.task.error || null, tokens: chat.task.tokens || 0,
  });
  let interactionsChanged = false;
  for (const entry of [...pendingInteractions.values()]) {
    if (entry.threadId !== chat.threadId) continue;
    const result = entry.kind === 'question' ? answerResponse(entry, {}) : approvalResponse(entry, false);
    appServer.respondToServerRequest(Number.isNaN(Number(entry.id)) ? entry.id : Number(entry.id), result);
    pendingInteractions.delete(entry.id);
    interactionsChanged = true;
  }
  if (interactionsChanged) send('interaction:update', publicInteractions());
  liveChats.delete(chat.threadId);
  releaseFinishedThread(chat.threadId);
}

function releaseFinishedThread(threadId) {
  loadedThreads.delete(threadId);
  Promise.resolve(appServer.unsubscribeThread({ threadId }))
    .catch(error => cfg.log('thread unsubscribe failed: ' + error.message))
    .finally(() => {
      clearTimeout(appServerIdleTimer);
      appServerIdleTimer = setTimeout(() => {
        if (!liveChats.size) appServer.stop();
      }, 120);
    });
}

function interactionSummary(method, params) {
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    return {
      kind: 'approval',
      title: '命令需要批准',
      reason: params.reason || 'Agent 请求运行一条需要确认的命令。',
      detail: params.command || params.commandLine || params.cmd || '',
    };
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    return {
      kind: 'approval',
      title: '文件修改需要批准',
      reason: params.reason || 'Agent 请求执行一项受保护的文件修改。',
      detail: params.grantRoot || params.cwd || '',
    };
  }
  if (method === 'item/permissions/requestApproval') {
    const permissions = params.permissions || {};
    return {
      kind: 'approval',
      title: '额外权限请求',
      reason: params.reason || 'Agent 请求当前工作区以外的额外权限。',
      detail: JSON.stringify(permissions),
    };
  }
  if (method === 'item/tool/requestUserInput') {
    return {
      kind: 'question',
      title: 'Agent 正在等你回答',
      reason: '回答后任务会继续执行。',
      detail: '',
      questions: Array.isArray(params.questions) ? params.questions : [],
    };
  }
  return null;
}

function queueServerInteraction(event) {
  const params = event.params || {};
  const summary = interactionSummary(event.method, params);
  if (!summary) {
    cfg.log('unsupported app-server request declined: ' + event.method);
    appServer.respondToServerRequest(event.id, appServer.deniedResponse(event.method));
    return;
  }
  const chat = params.threadId && liveChats.get(params.threadId);
  const entry = {
    id: String(event.id),
    method: event.method,
    params,
    threadId: params.threadId || (chat && chat.threadId) || null,
    turnId: params.turnId || (chat && chat.turnId) || null,
    petId: chat ? chat.task.petId : 'supervisor',
    taskId: chat ? chat.task.id : null,
    createdAt: Date.now(),
    ...summary,
  };
  pendingInteractions.set(entry.id, entry);
  if (chat) {
    chat.task.status = 'waiting_input';
    persistStandaloneTask(chat.task);
  }
  send('interaction:update', publicInteractions());
  send('chat:event', {
    type: 'needs-input', taskId: entry.taskId, petId: entry.petId,
    threadId: entry.threadId, interaction: publicInteractions().find(item => item.id === entry.id),
  });
}

function approvalResponse(entry, approved) {
  const method = entry.method;
  if (method === 'item/permissions/requestApproval') {
    return { permissions: approved ? (entry.params.permissions || {}) : {}, scope: 'turn' };
  }
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return approved
      ? { decision: 'approved' }
      : { decision: { denied: { rejection: '用户在 Pet Office 中拒绝了此操作。' } } };
  }
  return { decision: approved ? 'accept' : 'decline' };
}

function answerResponse(entry, answers) {
  const mapped = {};
  for (const question of entry.questions || []) {
    const value = answers && answers[question.id];
    mapped[question.id] = { answers: Array.isArray(value) ? value.map(String) : [String(value || '')] };
  }
  return { answers: mapped };
}

function resolveServerInteraction({ id, approved, answers }) {
  const entry = pendingInteractions.get(String(id));
  if (!entry) return { ok: false, error: '这条请求已经处理或不存在。' };
  const result = entry.kind === 'question' ? answerResponse(entry, answers || {}) : approvalResponse(entry, !!approved);
  appServer.respondToServerRequest(Number.isNaN(Number(entry.id)) ? entry.id : Number(entry.id), result);
  pendingInteractions.delete(entry.id);
  const chat = entry.threadId && liveChats.get(entry.threadId);
  if (chat) {
    chat.task.status = 'running';
    persistStandaloneTask(chat.task);
  }
  send('interaction:update', publicInteractions());
  send('chat:event', {
    type: 'resumed', taskId: entry.taskId, petId: entry.petId,
    threadId: entry.threadId, approved: entry.kind === 'question' ? null : !!approved,
  });
  return { ok: true };
}

function onAppServerEvent(event) {
  if (event.type === 'closed') {
    loadedThreads.clear();
    for (const chat of [...liveChats.values()]) finishChat(chat, 'failed', 'Codex App Server 已断开');
    return;
  }
  if (event.type === 'server-request') {
    queueServerInteraction(event);
    return;
  }
  if (event.type !== 'notification') return;
  const params = event.params || {};
  const chat = params.threadId && liveChats.get(params.threadId);
  if (!chat) return;

  const itemProgress = appServerItemProgress(event.method, params.item);
  if (itemProgress) {
    chat.task.progress = itemProgress.text;
    chat.task.progressStage = itemProgress.stage;
    chat.task.updatedAt = Date.now();
    persistStandaloneTask(chat.task);
    send('chat:event', {
      type: 'progress', taskId: chat.task.id, petId: chat.task.petId,
      threadId: chat.threadId, turnId: chat.turnId, ...itemProgress,
      task: { ...chat.task },
    });
    return;
  }

  if (event.method === 'item/agentMessage/delta') {
    const delta = String(params.delta || '');
    if (!delta) return;
    chat.output += delta;
    chat.pendingDelta += delta;
    if (!chat.flushTimer) chat.flushTimer = setTimeout(() => flushChatDelta(chat), 90);
    return;
  }
  if (event.method === 'thread/tokenUsage/updated') {
    const total = params.tokenUsage && params.tokenUsage.total;
    if (total && Number.isFinite(total.totalTokens)) {
      chat.task.tokens = Math.max(chat.task.tokens || 0, total.totalTokens);
      persistStandaloneTask(chat.task);
      send('chat:event', { type: 'usage', taskId: chat.task.id, petId: chat.task.petId, tokens: chat.task.tokens });
    }
    return;
  }
  if (event.method === 'turn/completed') {
    const turn = params.turn || {};
    const message = turn.error && (turn.error.message || turn.error.additionalDetails);
    finishChat(chat, turn.status || 'failed', message || null);
  }
}

async function startPetChat({ taskText, projectId, petId, model }) {
  const proj = projectId ? state.projects.find(project => project.id === projectId) : activeProject();
  if (!proj) return { ok: false, error: '还没有项目。请先新建或选择一个项目。' };
  const pet = petRoster().find(item => item.id === petId);
  if (!pet) return { ok: false, error: '找不到这个 Agent。' };
  const text = String(taskText || '').trim();
  if (!text) return { ok: false, error: '消息不能为空。' };

  const cap = state.caps[pet.id];
  const used = petSessionTokens.get(pet.id) || 0;
  if (cap && used >= cap) return { ok: false, error: '这个 Agent 已达到你设置的用量上限。' };

  dispatcher.ensureProjectDirs(proj.path);
  const key = proj.id + ':' + pet.id;
  const existingThread = petThreads.get(key);
  if (startingChats.has(key) || (existingThread && liveChats.has(existingThread))) return { ok: false, error: pet.name + ' 正在处理上一条消息。' };
  startingChats.add(key);
  clearTimeout(appServerIdleTimer);

  let threadId = existingThread;
  try {
    if (threadId && !loadedThreads.has(threadId)) {
      try {
        await appServer.resumeThread({ threadId, cwd: proj.path, model: model || pet.model || null });
        loadedThreads.add(threadId);
      } catch (error) {
        // Codex Desktop and Pet Office cannot both be the writer of one thread.
        // If the previous conversation is open in Codex, continue in a fresh
        // desktop-visible thread instead of exposing the protocol error.
        if (!/active writer|already has .*writer/i.test(String(error && error.message))) throw error;
        cfg.log('saved thread is owned by Codex Desktop; creating a new companion thread: ' + threadId);
        petThreads.delete(key);
        threadId = null;
      }
    }
    if (!threadId) {
      const thread = await appServer.startThread({ cwd: proj.path, model: model || pet.model || null, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      threadId = thread.threadId;
      if (!threadId) throw new Error('Codex App Server 未返回 threadId');
      petThreads.set(key, threadId);
      loadedThreads.add(threadId);
      state.conversations = Object.fromEntries(petThreads);
      cfg.saveState(state);
      proj.threadIds = Array.isArray(proj.threadIds) ? proj.threadIds : [];
      if (!proj.threadIds.includes(threadId)) proj.threadIds.push(threadId);
      proj.threadIds = proj.threadIds.slice(-30);
      try {
        await appServer.setThreadName({ threadId, name: text.replace(/\s+/g, ' ').slice(0, 60) });
      } catch (error) {
        cfg.log('thread name failed: ' + error.message);
      }
    }

    const task = {
      id: 'chat-' + Date.now().toString(36) + '-' + pet.id,
      petId: pet.id,
      petName: pet.name,
      projectId: proj.id,
      projectName: proj.name,
      cwd: proj.path,
      model: model || pet.model || null,
      brief: text,
      status: 'running',
      startedAt: Date.now(),
      tokens: 0,
      threadId,
      resultPath: '',
      kind: 'conversation',
      source: 'pet-chat',
    };
    const chat = { task, threadId, turnId: null, output: '', pendingDelta: '', flushTimer: null, startedAt: Date.now() };
    liveChats.set(threadId, chat);
    persistStandaloneTask(task);
    send('chat:event', { type: 'started', taskId: task.id, petId: pet.id, threadId, text });
    const result = await appServer.startTurn({ threadId, text, model: task.model });
    chat.turnId = (result && (result.turnId || (result.turn && result.turn.id))) || null;
    chat.task.turnId = chat.turnId;
    persistStandaloneTask(chat.task);
    cfg.saveState(state);
    return { ok: true, taskId: task.id, threadId, turnId: chat.turnId };
  } catch (error) {
    const chat = threadId && liveChats.get(threadId);
    if (chat) finishChat(chat, 'failed', error.message);
    else send('chat:event', { type: 'failed', petId: pet.id, threadId: threadId || null, error: error.message });
    return { ok: false, error: error.message };
  } finally {
    startingChats.delete(key);
  }
}

async function cancelPetChat(taskId) {
  const chat = chatForTask(taskId);
  if (!chat) return false;
  try {
    if (chat.turnId) await appServer.interruptTurn({ threadId: chat.threadId, turnId: chat.turnId });
  } catch (error) {
    cfg.log('chat interrupt failed: ' + error.message);
  }
  finishChat(chat, 'interrupted', '已取消');
  return true;
}

function serializeBatch(b) {
  return [...b.tasks.values()].map(t => ({ ...t }));
}

function persistTask(batch, task) {
  if (!Array.isArray(state.history)) state.history = [];
  const record = { ...task, batchId: batch.id, projectName: batch.projectName, projectId: batch.projectId };
  const index = state.history.findIndex(x => x.id === task.id);
  if (index >= 0) state.history[index] = record;
  else state.history.push(record);
  state.history = state.history.slice(-100);
  cfg.saveState(state);
  emitTaskSnapshot();
}

function summaryMarkdown(batch) {
  const lines = ['# Pet Office 汇总', '- 项目: ' + batch.projectName, '- 任务: ' + batch.taskText, '- 完成: ' + new Date().toLocaleString('zh-CN'), '', '## 各成员结果'];
  for (const t of batch.tasks.values()) {
    lines.push('### ' + t.petName + ' · ' + (t.model || 'codex默认') + ' · ' + t.status);
    lines.push('**简报**: ' + (t.brief || ''));
    let body = '';
    try { body = fs.readFileSync(t.resultPath, 'utf8'); } catch {}
    lines.push(body ? '**结果**:\n\n' + body.slice(0, 6000) : '(无结果文件)');
  }
  return lines.join('\n\n');
}

function checkBatchDone(batch) {
  const all = [...batch.tasks.values()];
  if (!all.length) return;
  if (!all.every(t => ['done', 'failed', 'cancelled', 'capped'].includes(t.status))) return;
  const md = summaryMarkdown(batch);
  const file = bridge.writeResult('batch-' + batch.id, md, {
    batchId: batch.id,
    project: batch.projectName,
    task: batch.taskText,
    tasks: all.map(t => ({ petName: t.petName, model: t.model, status: t.status, tokens: t.tokens, threadId: t.threadId })),
  });
  batch.summaryFile = file;
  cfg.log('batch done: ' + file);
  send('batch:done', { batchId: batch.id, file, tasks: serializeBatch(batch) });
}

async function startDelegation({ taskText, projectId, participants, usePlanner }) {
  const proj = projectId ? state.projects.find(p => p.id === projectId) : activeProject();
  if (!proj) return { ok: false, error: '还没有项目。请先新建或选择一个项目。' };
  const plist = (participants || []).filter(p => p.use);
  if (!plist.length) return { ok: false, error: '至少选择一个参与者。' };
  dispatcher.ensureProjectDirs(proj.path);
  const batchId = 'b' + (++batchSeq).toString(36) + Date.now().toString(36);
  const batch = { id: batchId, projectId: proj.id, projectName: proj.name, projectPath: proj.path, taskText: String(taskText || ''), tasks: new Map(), usePlanner: !!usePlanner, createdAt: Date.now() };
  batches.set(batchId, batch);

  let briefs;
  if (usePlanner) {
    send('batch:update', { batchId, phase: 'planning', taskText: batch.taskText, projectId: proj.id, projectName: proj.name });
    const plan = await planner.splitTask({ projectDir: proj.path, text: taskText, participants: plist.map(p => p.name) });
    briefs = new Map();
    for (const p of plist) {
      const hit = plan ? plan.find(x => x.name === p.name) : null;
      briefs.set(p.petId, (hit && hit.brief) || taskText);
    }
  } else {
    briefs = new Map(plist.map(p => [p.petId, taskText]));
  }

  for (const p of plist) {
    const id = batchId + '-' + p.petId;
    const cap = state.caps[p.petId];
    const tok = petSessionTokens.get(p.petId) || 0;
    if (cap && tok >= cap) {
      const capped = { id, source: 'delegation', petId: p.petId, petName: p.name, model: p.model || '(默认)', brief: briefs.get(p.petId), status: 'capped', startedAt: Date.now(), tokens: tok, threadId: null, cwd: proj.path, resultPath: '' };
      batch.tasks.set(id, capped);
      persistTask(batch, capped);
      continue;
    }
    const task = {
      id, source: 'delegation', petId: p.petId, petName: p.name, model: p.model || null, brief: briefs.get(p.petId),
      status: 'queued', startedAt: Date.now(), tokens: 0, threadId: null,
      cwd: proj.path,
      resultPath: path.join(proj.path, 'tasks', id + '.result.md'),
    };
    batch.tasks.set(id, task);
    persistTask(batch, task);
    dispatcher.startTask({ id, petId: p.petId, petName: p.name, model: p.model || null, brief: briefs.get(p.petId), projectDir: proj.path });
  }
  send('batch:update', { batchId, phase: 'running', tasks: serializeBatch(batch) });
  return { ok: true, batchId };
}

function onTaskEvent(ev) {
  const batch = [...batches.values()].find(b => b.tasks.has(ev.taskId));
  if (!batch) return;
  const rec = batch.tasks.get(ev.taskId);
  switch (ev.type) {
    case 'started': rec.status = 'running'; rec.startedAt = Date.now(); break;
    case 'progress':
      rec.progress = String(ev.text || '').slice(0, 320);
      rec.progressStage = ev.stage || 'working';
      rec.updatedAt = Date.now();
      break;
    case 'session': {
      rec.threadId = ev.threadId;
      const proj = state.projects.find(p => p.id === batch.projectId);
      if (proj && ev.threadId) {
        proj.threadIds = Array.isArray(proj.threadIds) ? proj.threadIds : [];
        if (!proj.threadIds.includes(ev.threadId)) proj.threadIds.push(ev.threadId);
        proj.threadIds = proj.threadIds.slice(-30);
      }
      break;
    }
    case 'usage': rec.tokens = Math.max(rec.tokens || 0, ev.tokens); break;
    case 'done':
      rec.status = 'done'; rec.elapsedMs = ev.elapsedMs;
      try {
        const resultPreview = fs.readFileSync(rec.resultPath, 'utf8').replace(/\s+/g, ' ').trim();
        if (resultPreview) rec.progress = resultPreview.slice(0, 320);
      } catch {}
      petSessionTokens.set(rec.petId, (petSessionTokens.get(rec.petId) || 0) + (rec.tokens || 0));
      break;
    case 'failed':
      if (rec.status === 'cancelled') break;
      rec.status = 'failed'; rec.error = ev.error || ('exit ' + ev.exitCode); rec.elapsedMs = ev.elapsedMs;
      petSessionTokens.set(rec.petId, (petSessionTokens.get(rec.petId) || 0) + (rec.tokens || 0));
      break;
    case 'cancelled': rec.status = 'cancelled'; break;
  }
  persistTask(batch, rec);
  send('task:event', { ...ev, batchId: batch.id, petId: rec.petId, task: { ...rec, batchId: batch.id, projectName: batch.projectName, projectId: batch.projectId } });
  checkBatchDone(batch);
}

function onBridgeOrder(order) {
  cfg.log('bridge order: ' + order.action);
  try {
    if (order.action === 'delegate') {
      let proj = null;
      if (order.project) {
        proj = state.projects.find(p => p.id === order.project || p.name === order.project)
          || createProjectDir(safeName(order.project), path.isAbsolute(order.project) ? order.project : undefined);
      } else {
        proj = activeProject() || createProjectDir('bridge-' + Date.now().toString(36));
      }
      const slots = state.pets.workers;
      const participants = (order.agents || []).slice(0, state.settings.workerSlots).map((a, i) => ({
        petId: slots[i] ? slots[i].id : 'w' + (i + 1),
        name: a.name || (slots[i] && slots[i].name) || ('worker-' + (i + 1)),
        model: a.model || null,
        use: true,
      }));
      bridge.writeResult('bridge-ack', '已接受任务。项目: ' + proj.name + '；参与者: ' + participants.map(p => p.name).join(', '), { acceptedAt: Date.now(), project: proj.name });
      startDelegation({ taskText: order.task || '(无任务描述)', projectId: proj.id, participants, usePlanner: order.usePlanner !== false });
    } else if (order.action === 'message') {
      send('pet:message', { text: String(order.text || '') });
      bridge.writeResult('message-ack', '桌宠已显示消息: ' + order.text, null);
    } else if (order.action === 'status') {
      const snap = [...batches.values()].slice(-5).map(b => ({ id: b.id, project: b.projectName, task: b.taskText, summaryFile: b.summaryFile || null, tasks: [...b.tasks.values()].map(t => t.petName + ':' + t.status) }));
      bridge.writeResult('status', JSON.stringify(snap, null, 2), null);
    }
  } catch (e) {
    bridge.writeResult('bridge-error', String((e && e.message) || e), null);
  }
}

async function refreshQuotas(force = false) {
  quotaCache = await quota.fetchQuotas(force);
  send('quota:update', quotaCache);
}

function applyAutostart() {
  try {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!state.settings.autostart, args: ['--hidden'] });
  } catch (e) { cfg.log('autostart: ' + e.message); }
}

function normalizedToggleShortcut(value) {
  return TOGGLE_SHORTCUTS.has(value) ? value : 'Control+Alt+P';
}

function registerGlobalShortcuts() {
  try { globalShortcut.unregisterAll(); } catch {}
  const requested = normalizedToggleShortcut(state.settings.toggleShortcut);
  state.settings.toggleShortcut = requested;
  let active = requested;
  let ok = false;
  try { ok = globalShortcut.register(requested, () => setWindowVisible(!win.isVisible())); } catch {}
  if (!ok && requested !== 'Control+Alt+P') {
    active = 'Control+Alt+P';
    try { ok = globalShortcut.register(active, () => setWindowVisible(!win.isVisible())); } catch {}
  }
  try {
    globalShortcut.register('Control+Alt+Q', () => { isQuitting = true; app.quit(); });
  } catch {}
  shortcutStatus = { ok, requested, active: ok ? active : null, fallback: ok && active !== requested };
  cfg.log('shortcut registration: ' + JSON.stringify(shortcutStatus));
  return shortcutStatus;
}

function trayImage() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="3" y="5" width="26" height="22" rx="10" fill="#F4A623"/><rect x="8" y="10" width="16" height="12" rx="5" fill="#202027"/><circle cx="13" cy="16" r="2" fill="#FFF7E2"/><circle cx="19" cy="16" r="2" fill="#FFF7E2"/></svg>';
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')).resize({ width: 16, height: 16 });
}

function setWindowVisible(show) {
  if (!win || win.isDestroyed()) return;
  if (show) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    send('pet:window-visible', true);
  } else {
    win.hide();
    send('pet:window-visible', false);
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip('Pet Office');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示桌宠', click: () => setWindowVisible(true) },
    { label: '隐藏桌宠（任务继续）', click: () => setWindowVisible(false) },
    { type: 'separator' },
    { label: '打开 Codex', click: () => shell.openExternal('codex://').catch(() => {}) },
    { type: 'separator' },
    { label: '退出 Pet Office', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => setWindowVisible(true));
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const captureArg = process.argv.find(x => x.startsWith('--capture-ui='));
  const capturePath = captureArg ? captureArg.slice('--capture-ui='.length) : null;
  const captureViewArg = process.argv.find(x => x.startsWith('--capture-view='));
  const captureView = captureViewArg ? captureViewArg.slice('--capture-view='.length) : 'panel';
  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true, frame: false, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setMenuBarVisibility(false);
  win.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    setWindowVisible(false);
  });
  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const action = captureView === 'experience'
            ? "(() => { S.settings.compactMode = true; S.settings.petScale = 1.2; S.settings.reducedMotion = true; S.shortcutStatus = { ok: true, active: 'Control+Alt+P', fallback: false }; applyAppearanceSettings(); setStatus(pets.get('supervisor'), 'needs_input'); openPanel('supervisor', 'settings'); return { compactMode: S.settings.compactMode, petScale: S.settings.petScale, reducedMotion: S.settings.reducedMotion }; })()"
            : captureView === 'appearance'
              ? "(() => { openPanel('supervisor', 'appearance'); const previews = [...document.querySelectorAll('[data-skin-preview]')].map(node => ({ slug: node.dataset.skinPreview, inlineSize: node.style.backgroundSize, imageLength: node.style.backgroundImage.length, imagePrefix: node.style.backgroundImage.slice(0, 28) })); return { cards: document.querySelectorAll('.skin-card').length, selected: document.querySelectorAll('.skin-card.selected').length, discover: document.querySelectorAll('[data-discover-skins]').length, previews }; })()"
            : captureView === 'appearance-bottom'
              ? "(async () => { openPanel('supervisor', 'appearance'); await Promise.all((S.skins || []).map(appearancePreviewUrl)); const page = document.querySelector('#panel .panel-page'); page.scrollTop = page.scrollHeight; return { cards: document.querySelectorAll('.skin-card').length, visibleNames: [...document.querySelectorAll('.skin-card b')].map(node => node.textContent), scrollTop: page.scrollTop }; })()"
            : captureView === 'live-task'
              ? "(() => { tasks = [{ id: 'live-1', petId: 'supervisor', petName: 'CC', model: null, brief: '优化桌宠任务动态显示', progress: '正在修改任务状态卡并运行回归测试…', progressStage: 'file', status: 'running', threadId: 'test-thread', startedAt: Date.now(), updatedAt: Date.now() }]; updateLiveTaskCard(); return { visible: !document.getElementById('live-task').classList.contains('hidden'), text: document.getElementById('live-task').innerText }; })()"
            : captureView === 'activity'
            ? "(() => { interactions = [{ id: 'test-approval', kind: 'approval', title: '命令需要批准', reason: 'Agent 请求运行测试命令', detail: 'npm test -- StatusBadge', threadId: 'test-thread', petId: 'supervisor', createdAt: Date.now() }, { id: 'test-question', kind: 'question', title: 'Agent 正在等你回答', reason: '回答后继续', threadId: 'test-thread', petId: 'w1', createdAt: Date.now(), questions: [{ id: 'scope', header: '测试范围', question: '要运行完整测试还是快速测试？', options: [{ label: '快速测试', description: '更快' }, { label: '完整测试', description: '更全面' }] }] }]; tasks = [{ id: 't1', petId: 'supervisor', petName: 'Michael', model: null, brief: '等待批准后继续修改项目', progress: '准备运行项目测试命令，等待你的确认', progressStage: 'command', status: 'waiting_input', threadId: 'test-thread', startedAt: Date.now() }, { id: 't2', petId: 'w1', petName: '小蓝', model: 'deepseek/deepseek-v4-flash', brief: '核验项目代码和测试结果', progress: '运行命令 · npm test -- --runInBand', progressStage: 'command', status: 'running', threadId: 'test-thread-2', startedAt: Date.now() - 1000 }, { id: 't3', petId: 'w2', petName: '小绿', model: null, brief: '界面优化已完成', progress: '界面与回归测试均已完成', progressStage: 'report', status: 'done', threadId: 'test-thread-3', startedAt: Date.now() - 2000 }]; updateActivityBadge(); openActivity(); return { interactions: interactions.length, tasks: tasks.length }; })()"
            : captureView === 'activity-live'
              ? "openActivity()"
            : captureView === 'live-task-real'
              ? "updateLiveTaskCard()"
            : captureView === 'status-cancelled'
              ? "(() => { const now = Date.now(); tasks = [{ id: 'd-old', petId: 'supervisor', source: 'desktop', surface: 'Codex 桌面端', brief: '旧完成任务', status: 'done', updatedAt: now - 60000, startedAt: now - 60000 }, { id: 'c-new', petId: 'supervisor', source: 'desktop', surface: 'Codex 桌面端', brief: '被中断的任务', status: 'cancelled', updatedAt: now - 400, startedAt: now - 6000 }]; previousTaskStatuses.set('c-new', 'running'); syncPetTaskStatus(); const boss = pets.get('supervisor'); const sig = boss.el.querySelector('.state-signal'); return { petStatus: boss.status, dataStatus: boss.el.dataset.status || null, signalDisplay: getComputedStyle(sig).display, signalContent: getComputedStyle(sig, '::before').content, dotColor: getComputedStyle(boss.el.querySelector('.tag .dot')).backgroundColor }; })()"
            : captureView === 'drop-files'
              ? "(async () => { const probe = await window.petOffice.ingestFiles(['C:/definitely-missing/probe.txt']); openComposer('supervisor', false); composerAttachments = [{ name: '季度报告.pdf', relPath: 'inbox/季度报告.pdf', kind: 'PDF', size: 20480 }, { name: 'photo.png', relPath: 'inbox/photo.png', kind: '图片', size: 102400 }]; renderComposerFiles(); const chips = [...document.querySelectorAll('#c-files .file-chip')]; return { ipcWired: !!(probe && probe.ok === false && probe.error), ipcError: probe ? probe.error : null, composerOpen: !document.getElementById('composer').classList.contains('hidden'), composerPet: composerPetId, chips: chips.length, chipNames: chips.map(node => node.querySelector('b').textContent), chipKinds: chips.map(node => node.querySelector('i').textContent), promptBlock: attachmentPromptBlock() }; })()"
            : captureView === 'dismiss'
              ? "(() => { const stage = document.getElementById('stage'); openPanel('supervisor'); const panelOpened = !document.getElementById('panel').classList.contains('hidden'); stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 })); const panelClosed = document.getElementById('panel').classList.contains('hidden'); openMenu('supervisor', 300, 300); const menuOpened = !document.getElementById('ctxmenu').classList.contains('hidden'); stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 })); const menuClosed = document.getElementById('ctxmenu').classList.contains('hidden'); return { panelOpened, panelClosed, menuOpened, menuClosed }; })()"
            : captureView === 'composer'
              ? "openComposer('supervisor', true)"
            : captureView === 'scale-dragtest'
              ? "(async () => { S.settings.compactMode = false; S.settings.petScale = 1.4; S.settings.reducedMotion = false; applyAppearanceSettings(); const el = document.getElementById('pet-supervisor'); const r0 = el.getBoundingClientRect(); const pos = (x, y) => ({ pointerId: 8, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }); const x0 = r0.left + 40; const y0 = r0.top + 40; el.dispatchEvent(new PointerEvent('pointerdown', pos(x0, y0))); document.dispatchEvent(new PointerEvent('pointermove', pos(x0 - 180, y0 - 120))); document.dispatchEvent(new PointerEvent('pointerup', pos(x0 - 180, y0 - 120))); await new Promise(r => setTimeout(r, 700)); const r1 = el.getBoundingClientRect(); return { scale: getComputedStyle(document.documentElement).getPropertyValue('--pet-scale').trim(), movedBy: Math.round(r1.left - r0.left) + ',' + Math.round(r1.top - r0.top), stored: (S.ui.petPositions || {}).supervisor || null, stillDragging: el.classList.contains('dragging') }; })()"
            : captureView === 'dragtest'
              ? "(async () => { const el = document.getElementById('pet-supervisor'); const r0 = el.getBoundingClientRect(); const pos = (x, y) => ({ pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }); const x0 = r0.left + 40; const y0 = r0.top + 40; el.dispatchEvent(new PointerEvent('pointerdown', pos(x0, y0))); document.dispatchEvent(new PointerEvent('pointermove', pos(x0 - 260, y0 - 160))); document.dispatchEvent(new PointerEvent('pointermove', pos(x0 - 420, y0 - 250))); document.dispatchEvent(new PointerEvent('pointerup', pos(x0 - 420, y0 - 250))); await new Promise(r => setTimeout(r, 700)); const r1 = el.getBoundingClientRect(); return { movedBy: Math.round(r1.left - r0.left) + ',' + Math.round(r1.top - r0.top), stored: (S.ui.petPositions || {}).supervisor || null, stillDragging: el.classList.contains('dragging') }; })()"
              : captureView === 'boba-composer'
                ? "(() => { const s = (S.skins || []).find(x => x.slug === 'boba'); if (s) { const p = pets.get('supervisor'); p.skin = s.slug; applySkin(p); } openComposer('supervisor', false); })()"
            : captureView === 'morph'
                ? "(async () => { const button = document.querySelector('#pet-supervisor [data-quick-chat]'); const before = button.getBoundingClientRect(); openComposer('supervisor', false); const composer = document.getElementById('composer'); const start = composer.getBoundingClientRect(); await new Promise(r => setTimeout(r, 420)); const settled = composer.getBoundingClientRect(); const rect = r => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; return { button: rect(before), start: rect(start), settled: rect(settled), className: composer.className }; })()"
              : captureView === 'poses'
                ? "(async () => { const boss = document.getElementById('pet-supervisor'); const sprite = boss.querySelector('.skin-sprite'); const wait = ms => new Promise(r => setTimeout(r, ms)); const row = () => sprite.style.backgroundPositionY; const out = {}; boss.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); await wait(260); out.hover = row(); boss.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false })); await wait(260); out.idle = row(); setStatus(pets.get('supervisor'), 'queued'); await wait(260); out.queued = row(); setStatus(pets.get('supervisor'), 'working'); await wait(260); out.working = row(); setStatus(pets.get('supervisor'), 'done'); await wait(260); out.celebrate = row(); await wait(2800); out.review = row(); setStatus(pets.get('supervisor'), 'failed'); await wait(260); out.failed = row(); setStatus(pets.get('supervisor'), 'idle'); await wait(200); walkTo(pets.get('supervisor'), innerWidth - 300, 200); await wait(260); out.runLeft = row(); return out; })()"
            : captureView === 'team'
              ? "openPanel('supervisor', 'team')"
              : captureView === 'deepseek'
                ? "(() => { const m = (S.models || []).find(x => x.provider === 'deepseek' || x.slug.startsWith('deepseek/')); if (m) pets.get('supervisor').model = m.slug; openPanel('supervisor'); })()"
              : "openPanel('supervisor')";
          const actionResult = await win.webContents.executeJavaScript(action);
          const captureState = await win.webContents.executeJavaScript("(() => { const c = document.getElementById('composer'); const r = c.getBoundingClientRect(); const boss = document.getElementById('pet-supervisor'); const b = boss.getBoundingClientRect(); const sprite = boss.querySelector('.skin-sprite'); const list = (S && S.skins) || []; const grids = typeof skinGrids !== 'undefined' ? [...skinGrids.entries()] : null; const pill = c.querySelector('.composer-input-row'); const pr = pill ? pill.getBoundingClientRect() : null; const lc = document.getElementById('live-task'); const allTasks = typeof tasks !== 'undefined' ? tasks : []; return { panel: !document.getElementById('panel').classList.contains('hidden'), activity: !document.getElementById('activity').classList.contains('hidden'), activityState: typeof activitySurface !== 'undefined' ? activitySurface.state : null, activityInteractions: document.querySelectorAll('.interaction-card').length, activityTasks: document.querySelectorAll('.activity-task').length, composer: !c.classList.contains('hidden'), composerClass: c.className, pets: document.querySelectorAll('.pet').length, skins: list.length, skinNames: list.map(s => s.slug), grids, skinApplied: boss.classList.contains('petdex-skin'), compactMode: document.body.classList.contains('compact-mode'), reducedMotion: document.body.classList.contains('reduce-motion'), petScale: getComputedStyle(document.documentElement).getPropertyValue('--pet-scale').trim(), stateSignal: getComputedStyle(boss.querySelector('.state-signal')).display, quickBarVisible: getComputedStyle(boss.querySelector('.quickbar')).opacity, quickButtons: boss.querySelectorAll('.quick-btn').length, liveTask: { visible: !lc.classList.contains('hidden'), text: lc.innerText, threadId: lc.dataset.threadId || null }, desktopMonitor: (S && S.desktopMonitor) || null, taskCount: allTasks.length, activeTasks: allTasks.filter(t => ['running', 'queued', 'waiting_input'].includes(t.status)).map(t => ({ source: t.source, threadId: t.threadId, status: t.status, brief: t.brief, progress: t.progress, model: t.model })), spriteAnimations: sprite.getAnimations().map(animation => ({ playState: animation.playState, iterations: animation.effect && animation.effect.getTiming ? animation.effect.getTiming().iterations : null })), spriteSize: sprite.style.backgroundSize, spriteRow: sprite.style.backgroundPositionY, composerBox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], pillBox: pr ? [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)] : null, petBox: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }; })()");
          cfg.log('capture-ui action: ' + JSON.stringify(actionResult || null));
          cfg.log('capture-ui state: ' + JSON.stringify(captureState));
          try { fs.writeFileSync(capturePath.replace(/\.png$/i, '.state.json'), JSON.stringify({ action: actionResult || null, state: captureState }, null, 2)); } catch {}
          await new Promise(resolve => setTimeout(resolve, 350));
          const image = await win.webContents.capturePage();
          fs.writeFileSync(capturePath, image.toPNG());
        } catch (e) {
          cfg.log('capture-ui: ' + e.message);
        } finally {
          app.quit();
        }
      }, 1200);
    });
  }
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

const captureMode = process.argv.some(arg => arg.startsWith('--capture-ui='));
const gotLock = captureMode || app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.whenReady().then(() => {
  if (captureMode) desktopMonitor.start();
  createWindow();
  if (captureMode) return;
  setTimeout(() => desktopMonitor.start(), 50);
  createTray();
  dispatcher.setConcurrency(state.settings.maxParallel);
  dispatcher.setEmitter(onTaskEvent);
  bridge.setHandler(onBridgeOrder);
  bridge.startWatching();
  refreshQuotas(true);
  setInterval(() => refreshQuotas(false), Math.max(30, state.settings.quotaPollSec) * 1000);
  applyAutostart();
  registerGlobalShortcuts();
  if (process.argv.includes('--hidden')) setTimeout(() => setWindowVisible(false), 800);
});

app.on('second-instance', () => setWindowVisible(true));
app.on('before-quit', () => {
  isQuitting = true;
  try { desktopMonitor.stop(); } catch {}
  try { appServer.stop(); } catch {}
});
app.on('window-all-closed', () => {});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });

ipcMain.handle('state:get', async () => ({ ...publicState(), models: catalog.loadModels(), tasks: activeTasksSnapshot() }));

function localTaskSource(task) {
  if (task.source) return task.source;
  return task.kind === 'conversation' ? 'pet-chat' : 'delegation';
}

function knownPetThreadIds() {
  const ids = new Set([...petThreads.values()].filter(Boolean));
  for (const project of state.projects || []) {
    for (const threadId of project.threadIds || []) if (threadId) ids.add(threadId);
  }
  for (const task of state.history || []) if (task.threadId) ids.add(task.threadId);
  for (const batch of batches.values()) {
    for (const task of batch.tasks.values()) if (task.threadId) ids.add(task.threadId);
  }
  return ids;
}

function activeTasksSnapshot() {
  const merged = new Map((state.history || []).map(task => [task.id, { ...task, source: localTaskSource(task) }]));
  for (const b of batches.values()) {
    for (const task of b.tasks.values()) {
      merged.set(task.id, {
        ...task,
        source: 'delegation',
        batchId: b.id,
        projectName: b.projectName,
        projectId: b.projectId,
      });
    }
  }
  for (const task of desktopMonitor.snapshot(knownPetThreadIds())) merged.set(task.id, task);
  return [...merged.values()]
    .sort((a, b) => (a.updatedAt || a.finishedAt || a.startedAt || 0) - (b.updatedAt || b.finishedAt || b.startedAt || 0))
    .slice(-140);
}

function emitTaskSnapshot() {
  send('task:snapshot', { tasks: activeTasksSnapshot(), monitor: desktopMonitorHealth });
}

ipcMain.on('mouse:ignore', (e, b) => { try { win.setIgnoreMouseEvents(!!b, { forward: true }); } catch {} });
ipcMain.handle('task:start', async (e, payload) => {
  const roster = petRoster();
  const participants = (payload.participants || []).map(p => {
    const r = roster.find(x => x.id === p.petId);
    const hasExplicitModel = Object.prototype.hasOwnProperty.call(p, 'model');
    return {
      petId: p.petId,
      name: p.name || (r && r.name) || p.petId,
      model: hasExplicitModel ? (p.model || null) : (r ? r.model : null),
      use: !!p.use,
    };
  });
  return startDelegation({ taskText: payload.taskText, projectId: payload.projectId, participants, usePlanner: !!payload.usePlanner });
});
ipcMain.handle('chat:start', async (e, payload) => startPetChat(payload || {}));
ipcMain.handle('interaction:respond', (e, payload) => resolveServerInteraction(payload || {}));
ipcMain.handle('task:cancel', async (e, id) => {
  if (chatForTask(id)) return cancelPetChat(id);
  dispatcher.cancel(id);
  return true;
});
ipcMain.handle('project:create', (e, name) => createProjectDir(name));
ipcMain.handle('project:add', async () => {
  try {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return createProjectDir(path.basename(r.filePaths[0]), r.filePaths[0]);
  } catch { return null; }
});
ipcMain.handle('project:select', (e, id) => { state.activeProjectId = id; cfg.saveState(state); return true; });
ipcMain.handle('settings:set', (e, patch) => {
  const previousShortcut = state.settings.toggleShortcut;
  Object.assign(state.settings, patch || {});
  state.settings.maxParallel = Math.max(1, Math.min(5, Number(state.settings.maxParallel) || 5));
  state.settings.petScale = Math.max(0.8, Math.min(1.4, Number(state.settings.petScale) || 1));
  state.settings.compactMode = !!state.settings.compactMode;
  state.settings.reducedMotion = !!state.settings.reducedMotion;
  state.settings.toggleShortcut = normalizedToggleShortcut(state.settings.toggleShortcut);
  if (app.isReady() && state.settings.toggleShortcut !== previousShortcut) registerGlobalShortcuts();
  cfg.saveState(state);
  dispatcher.setConcurrency(state.settings.maxParallel);
  applyAutostart();
  return publicState();
});
ipcMain.handle('ui:set', (e, patch) => {
  Object.assign(state.ui, patch || {});
  if (!Array.isArray(state.ui.hiddenPets)) state.ui.hiddenPets = [];
  cfg.saveState(state);
  return publicState();
});
ipcMain.handle('pet:rename', (e, { petId, name }) => {
  const n = String(name || '').trim().slice(0, 20);
  if (!n) return false;
  if (petId === 'supervisor') state.pets.supervisor.name = n;
  else { const w = state.pets.workers.find(x => x.id === petId); if (w) w.name = n; }
  cfg.saveState(state);
  return true;
});
ipcMain.handle('pet:model', (e, { petId, model }) => {
  const m = model || null;
  if (petId === 'supervisor') state.pets.supervisor.model = m;
  else { const w = state.pets.workers.find(x => x.id === petId); if (w) w.model = m; }
  cfg.saveState(state);
  return true;
});
ipcMain.handle('pet:skin', (e, { petId, skin }) => {
  const value = skin || null;
  if (petId === 'supervisor') state.pets.supervisor.skin = value;
  else { const worker = state.pets.workers.find(item => item.id === petId); if (worker) worker.skin = value; }
  cfg.saveState(state);
  return true;
});
ipcMain.handle('skin:data', (e, slug) => {
  const skin = loadPetdexSkins().find(item => item.slug === slug);
  return skin && skin.spritePath ? spriteDataUrl(skin.spritePath) : null;
});
ipcMain.handle('skins:refresh', () => {
  skinCache = { at: 0, items: [] };
  return loadPetdexSkins(true);
});
ipcMain.handle('cap:set', (e, { petId, cap }) => {
  state.caps[petId] = cap ? Math.max(0, Number(cap) | 0) : null;
  cfg.saveState(state);
  return true;
});
ipcMain.handle('shell:open', (e, p) => { try { return shell.openPath(p); } catch { return null; } });
ipcMain.handle('files:ingest', async (e, payload = {}) => {
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  let proj = payload.projectId ? state.projects.find(item => item.id === payload.projectId) : activeProject();
  if (!proj) {
    const stamp = new Date().toISOString().slice(0, 10);
    proj = createProjectDir('上传-' + stamp);
    cfg.log('files:ingest created project ' + proj.name);
  }
  const result = inbox.ingestFiles({ paths, projectPath: proj.path });
  cfg.log('files:ingest ' + JSON.stringify({ received: result.files.length, skipped: result.skipped.length, project: proj.name }));
  return { ...result, project: { id: proj.id, name: proj.name, path: proj.path } };
});
ipcMain.handle('codex:open', async (e, threadId) => {
  if (threadId && !liveChats.size && appServer.child) {
    appServer.stop();
    loadedThreads.clear();
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  const url = threadId ? 'codex://threads/' + threadId : 'codex://';
  try { await shell.openExternal(url); } catch { try { await shell.openExternal('codex://'); } catch {} }
  return true;
});
ipcMain.handle('petdex:open', async () => {
  try { await shell.openExternal('https://petdex.dev/'); } catch {}
  return true;
});
ipcMain.handle('quota:refresh', async () => { await refreshQuotas(true); return quotaCache; });
ipcMain.handle('app:hide', () => { setWindowVisible(false); return true; });
ipcMain.handle('app:show', () => { setWindowVisible(true); return true; });
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });
