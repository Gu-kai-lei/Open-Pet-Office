'use strict';
const { app, BrowserWindow, ipcMain, screen, dialog, shell, globalShortcut, Tray, Menu, nativeImage, Notification, crashReporter, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const cfg = require('./config');
const catalog = require('./catalog');
const quota = require('./quota');
const dispatcher = require('./dispatcher');
const planner = require('./planner');
const bridge = require('./bridge');
const { AppServerClient } = require('./appserver');
const { CodexSessionMonitor, _internals: { redact: safeProgressText } } = require('./session-monitor');
const { workspacePath, openablePath } = require('./path-safety');
const inbox = require('./inbox');
const diagnostics = require('./diagnostics');
const { MissionManager } = require('./mission-manager');
const { RufloRuntimeManager } = require('./ruflo-runtime');
const { RufloAdapter } = require('./ruflo-adapter');
const { LocalCoordinator } = require('./local-coordinator');
const { hydrateProject, clearProjectInbox } = require('./project-service');
const { recommendAgents } = require('./recommender');
const releaseManager = require('./release-manager');
const { isFullscreenBounds, probeForegroundWindow, stopForegroundProbe } = require('./fullscreen-probe');
const { normalizeDroppedLinks } = require('./link-utils');
const { RENDERER_SETTINGS, RENDERER_UI, pickKeys, delegationEngine } = require('./ipc-guards');
const { captureScript, CAPTURE_STATE_SCRIPT } = require('./capture-views');

cfg.ensureDirs();
try {
  const providerSync = require('./codex-transport').ensureUserProviderConfig();
  if (providerSync.changed) cfg.log('codex transport: persisted OpenCodex HTTP provider so desktop can open Pet Office threads' + (providerSync.backup ? '; previous config saved as ' + path.basename(providerSync.backup) : ''));
} catch (error) {
  cfg.log('codex transport provider sync failed: ' + error.message);
}
// An isolated run (PET_OFFICE_HOME) must not share Chromium storage or the
// single-instance lock with an installed copy of the app.
if (process.env.PET_OFFICE_HOME) {
  try { app.setPath('userData', path.join(cfg.DIRS.app, 'electron')); } catch (error) { cfg.log('userData override failed: ' + error.message); }
}
try {
  app.setPath('crashDumps', cfg.DIRS.crashes);
  crashReporter.start({ uploadToServer: false, compress: true });
} catch (error) {
  cfg.log('crash reporter start failed: ' + error.message);
}

let win = null;
let tray = null;
let isQuitting = false;
let state = cfg.loadState();
if (!state.projects.some(project => project.id === state.activeProjectId && !project.archived)) {
  state.activeProjectId = (state.projects.find(project => !project.archived) || {}).id || null;
}
let quotaCache = { at: 0, lastSuccessAt: 0, ok: false, stale: false, reports: [], error: null };
let skinCache = { at: 0, items: [] };
const spriteDataCache = new Map();
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
const CAPTURE_SHORTCUTS = new Set(['Control+Alt+S', 'Super+Alt+S', 'Control+Shift+S', 'Alt+Shift+S']);
let shortcutStatus = { ok: true, active: state.settings.toggleShortcut || 'Control+Alt+P', fallback: false, captureOk: true, captureActive: state.settings.captureShortcut || 'Control+Alt+S' };
let captureInFlight = false;
let captureEpoch = 0;
let cancelCaptureWait = null;
let activeDisplayId = null;
let fullscreenActive = false;
let fullscreenTimer = null;
let fullscreenProbeRunning = false;
let releaseCache = {
  currentVersion: app.getVersion(),
  update: null,
  signature: { status: app.isPackaged ? 'checking' : 'development', signed: false, detail: app.isPackaged ? '正在检查签名…' : '开发模式未签名' },
  crashes: releaseManager.crashReportSummary(cfg.DIRS.crashes),
};
const notificationTimes = new Map();
const rufloRuntime = new RufloRuntimeManager({
  root: cfg.DIRS.ruflo,
  log: cfg.log,
  onStatus: status => send('ruflo:status', status),
});
const ruflo = new RufloAdapter({ runtime: rufloRuntime, log: cfg.log });

function redactCrashText(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[已隐藏]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[已隐藏]')
    .replace(/\b(api[_ -]?key|token|password|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[已隐藏]')
    .slice(0, 12000);
}

function writeCrashReport(kind, error, metadata = {}) {
  try {
    fs.mkdirSync(cfg.DIRS.crashes, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(cfg.DIRS.crashes, stamp + '-' + String(kind || 'error').replace(/[^a-z0-9_-]/gi, '-') + '.json');
    const payload = {
      at: new Date().toISOString(), kind, version: app.getVersion(), platform: process.platform,
      message: redactCrashText(error && (error.stack || error.message) || error), metadata,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    releaseCache.crashes = releaseManager.crashReportSummary(cfg.DIRS.crashes);
    cfg.log('crash report saved: ' + path.basename(file));
    return file;
  } catch (reportError) {
    cfg.log('crash report failed: ' + reportError.message);
    return null;
  }
}

process.on('uncaughtException', error => { writeCrashReport('main-uncaught', error); });
process.on('unhandledRejection', error => { writeCrashReport('main-rejection', error); });

const desktopMonitor = new CodexSessionMonitor({
  sessionsRoot: path.join(cfg.CODEX_HOME, 'sessions'),
  log: cfg.log,
  onChange: payload => {
    desktopMonitorHealth = payload.monitor || desktopMonitorHealth;
    emitTaskSnapshot();
  },
});

const missionManager = new MissionManager({
  runtimeRoot: cfg.DIRS.runtime,
  projects: () => state.projects || [],
  roster: () => petRoster(),
  supervisorModel: () => state.pets.supervisor.model || null,
  models: () => catalog.loadModels(),
  planner,
  dispatcher,
  local: new LocalCoordinator({ root: cfg.DIRS.memory, log: cfg.log }),
  ruflo,
  engine: () => state.settings.delegationEngine,
  log: cfg.log,
  onSnapshot: missions => {
    send('mission:snapshot', { missions });
    emitTaskSnapshot();
  },
  onTaskEvent: (event, mission, task) => {
    send('task:event', {
      ...event,
      taskId: mission.id + ':' + task.id,
      missionId: mission.id,
      petId: task.assigneePetId,
      task: {
        id: mission.id + ':' + task.id,
        missionId: mission.id,
        missionTaskId: task.id,
        source: 'mission',
        petId: task.assigneePetId,
        petName: task.assigneeName,
        model: task.actualModel || task.model,
        brief: task.title,
        status: task.status,
        threadId: task.threadId || null,
      },
    });
  },
  onDone: mission => {
    send('mission:done', mission);
    systemNotify('Mission 已结束', mission.objective + ' · ' + mission.status, mission.status === 'completed' ? 'completion' : 'attention', 'mission-' + mission.id);
    if (mission.status === 'completed' || mission.status === 'partial' || mission.status === 'partially_succeeded') {
      bridge.writeResult('mission-' + mission.id, mission.finalReview ? mission.finalReview.summary : 'Mission 已完成。', mission);
    }
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
cfg.saveState(state, true);

function send(ch, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); } catch {}
}

function displaySnapshot() {
  if (!app.isReady()) return [];
  return screen.getAllDisplays().map((display, index) => ({
    id: String(display.id),
    label: (display.label || ('显示器 ' + (index + 1))) + (display.id === screen.getPrimaryDisplay().id ? ' · 主屏' : ''),
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    primary: display.id === screen.getPrimaryDisplay().id,
  }));
}

function selectedDisplay() {
  const displays = screen.getAllDisplays();
  const mode = String(state.settings.displayMode || 'cursor');
  if (mode === 'cursor') return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (mode === 'primary') return screen.getPrimaryDisplay();
  return displays.find(display => String(display.id) === mode) || screen.getPrimaryDisplay();
}

function repositionWindow() {
  if (!win || win.isDestroyed() || !app.isReady()) return;
  const display = selectedDisplay();
  activeDisplayId = String(display.id);
  const area = display.workArea;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height }, false);
  send('desktop:display', { activeDisplayId, displays: displaySnapshot(), bounds: area });
}

function notificationAllowed(kind) {
  const mode = state.settings.notificationMode || 'standard';
  if (mode === 'quiet') return ['attention', 'error'].includes(kind);
  if (mode === 'standard') return ['attention', 'error', 'completion'].includes(kind);
  return true;
}

function systemNotify(title, body, kind = 'standard', key = title) {
  if (!notificationAllowed(kind) || !Notification.isSupported()) return false;
  const mode = state.settings.notificationMode || 'standard';
  if (win && win.isVisible() && !['attention', 'error'].includes(kind)) return false;
  const now = Date.now();
  if (now - (notificationTimes.get(key) || 0) < (kind === 'detail' ? 15000 : 2500)) return false;
  notificationTimes.set(key, now);
  try {
    const notification = new Notification({ title: String(title || 'Pet Office').slice(0, 80), body: String(body || '').replace(/\s+/g, ' ').slice(0, 220), silent: mode === 'quiet' });
    notification.on('click', () => setWindowVisible(true));
    notification.show();
    return true;
  } catch { return false; }
}

function applyFullscreenState(active, detail = null) {
  if (fullscreenActive === active) return;
  fullscreenActive = active;
  const behavior = state.settings.fullscreenBehavior || 'corner';
  if (win && !win.isDestroyed()) {
    try { win.setOpacity(active && behavior === 'hide' ? 0 : 1); } catch {}
    if (active && behavior === 'hide') win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  }
  send('desktop:fullscreen', { active, behavior, detail });
}

async function pollFullscreen() {
  if (fullscreenProbeRunning || !win || win.isDestroyed()) return;
  const behavior = state.settings.fullscreenBehavior || 'corner';
  if (behavior === 'ignore') { applyFullscreenState(false); return; }
  fullscreenProbeRunning = true;
  try {
    const foreground = await probeForegroundWindow();
    const shellClasses = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd']);
    let active = false;
    let display = null;
    if (foreground && foreground.pid !== process.pid && !shellClasses.has(foreground.class)) {
      display = screen.getDisplayMatching(foreground);
      active = isFullscreenBounds(foreground, display.bounds);
    }
    applyFullscreenState(active, active ? { displayId: String(display.id), className: foreground.class } : null);
  } finally {
    fullscreenProbeRunning = false;
  }
}

function configureFullscreenMonitor() {
  clearInterval(fullscreenTimer);
  fullscreenTimer = null;
  applyFullscreenState(false);
  if ((state.settings.fullscreenBehavior || 'corner') === 'ignore') { stopForegroundProbe(); return; }
  pollFullscreen();
  fullscreenTimer = setInterval(pollFullscreen, 6000);
  if (fullscreenTimer.unref) fullscreenTimer.unref();
}

async function checkForUpdates(force = false) {
  if (!force && releaseCache.update && Date.now() - (releaseCache.update.checkedAt || 0) < 6 * 60 * 60 * 1000) return releaseCache;
  const result = await releaseManager.checkLatestRelease({ currentVersion: app.getVersion() });
  releaseCache.update = { ...result, checkedAt: Date.now() };
  send('release:update', releaseCache);
  if (result.ok && result.updateAvailable) systemNotify('Pet Office 有新版本', 'v' + result.latestVersion + ' 已发布，点击应用内“更新检查”查看。', 'completion', 'update-' + result.latestVersion);
  return releaseCache;
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
    missions: missionManager.snapshot(),
    desktop: { displays: displaySnapshot(), activeDisplayId, fullscreenActive },
    release: releaseCache,
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
    { id: 'supervisor', role: 'supervisor', name: state.pets.supervisor.name, model: state.pets.supervisor.model, modelMode: state.pets.supervisor.modelMode || 'auto' },
    ...state.pets.workers.map(w => ({ id: w.id, role: 'worker', name: w.name, model: w.model, modelMode: w.modelMode || 'auto' })),
  ];
}

function safeName(s) {
  const n = String(s || 'project').replace(/[\\/:*?"<>|]/g, '-').trim();
  return (n || 'project').slice(0, 60);
}

function createProjectDir(name, explicitPath) {
  const p = explicitPath || path.join(cfg.DIRS.projectsRoot, safeName(name));
  fs.mkdirSync(p, { recursive: true });
  missionManager.store.ensureProject(p);
  let proj = state.projects.find(x => path.resolve(x.path) === path.resolve(p));
  if (!proj) {
    proj = hydrateProject({ id: 'p' + Date.now().toString(36), name: name || path.basename(p), path: p, threadIds: [] });
    state.projects.push(proj);
  } else {
    proj.archived = false;
    proj.updatedAt = Date.now();
  }
  state.activeProjectId = proj.id;
  cfg.saveState(state);
  return proj;
}

function activeProject() {
  return state.projects.find(p => p.id === state.activeProjectId && !p.archived) || null;
}

function projectById(id) {
  return state.projects.find(project => project.id === id) || null;
}

function nextActiveProject(excludeId = null) {
  return state.projects.find(project => !project.archived && project.id !== excludeId) || null;
}

function projectBusy(projectId) {
  const live = [...liveChats.values()].find(chat => chat.task.projectId === projectId);
  if (live) return { busy: true, reason: '项目中仍有桌宠会话正在运行。' };
  const activeMission = missionManager.snapshot().find(mission => mission.projectId === projectId && ['setup', 'planning', 'awaiting_confirmation', 'running', 'reviewing', 'integrating', 'needs_input', 'interrupted'].includes(mission.status));
  if (activeMission) return { busy: true, reason: '项目中仍有未结束的 Mission。' };
  return { busy: false };
}

function projectSessions(projectId) {
  const project = projectById(projectId);
  if (!project) return [];
  const mapped = new Map();
  for (const [key, threadId] of petThreads.entries()) {
    if (!key.startsWith(projectId + ':') || !threadId) continue;
    mapped.set(threadId, key.slice(projectId.length + 1));
  }
  const history = (state.history || []).filter(task => task.projectId === projectId && task.threadId);
  const monitored = desktopMonitor.snapshot(knownPetThreadIds()).filter(task => {
    if (task.projectId === projectId) return true;
    return task.cwd && path.resolve(task.cwd) === path.resolve(project.path);
  });
  const threadIds = new Set([...(project.threadIds || []), ...history.map(task => task.threadId), ...monitored.map(task => task.threadId)].filter(Boolean));
  return [...threadIds].map(threadId => {
    const records = history.filter(task => task.threadId === threadId);
    const latest = [...records, ...monitored.filter(task => task.threadId === threadId)].sort((a, b) => (b.updatedAt || b.finishedAt || b.startedAt || 0) - (a.updatedAt || a.finishedAt || a.startedAt || 0))[0] || null;
    const petId = mapped.get(threadId) || (latest && latest.petId) || null;
    const pet = petRoster().find(item => item.id === petId);
    return {
      threadId,
      petId,
      petName: (pet && pet.name) || (latest && latest.petName) || 'Agent',
      title: (latest && latest.brief) || 'Codex 会话',
      status: (latest && latest.status) || 'idle',
      model: (latest && latest.model) || (pet && pet.model) || null,
      current: !!mapped.get(threadId),
      updatedAt: (latest && (latest.updatedAt || latest.finishedAt || latest.startedAt)) || 0,
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
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
    return { stage: 'command', text: (completed ? '已完成命令' : '正在运行命令') + (command ? ' · ' + safeProgressText(command, 180) : '') };
  }
  if (type.includes('file') || type.includes('patch')) {
    const pathText = item.path || item.filePath || (Array.isArray(item.changes) && item.changes[0] && (item.changes[0].path || item.changes[0].filePath)) || '';
    return { stage: 'file', text: (completed ? '已更新文件' : '正在修改文件') + (pathText ? ' · ' + safeProgressText(pathText, 180) : '') };
  }
  if (type.includes('tool') || type.includes('mcp')) {
    const name = item.name || item.tool || item.server || '';
    return { stage: 'tool', text: (completed ? '工具调用完成' : '正在调用工具') + (name ? ' · ' + safeProgressText(name, 120) : '') };
  }
  if (type.includes('reason') || type.includes('analysis')) return { stage: 'thinking', text: completed ? '分析完成，准备下一步…' : '正在分析任务…' };
  return null;
}

function finishChat(chat, status, error) {
  if (!chat || liveChats.get(chat.threadId) !== chat) return;
  clearTimeout(chat.flushTimer);
  flushChatDelta(chat);
  chat.task.status = status === 'completed' ? 'done' : (status === 'interrupted' ? 'cancelled' : 'failed');
  chat.task.elapsedMs = Date.now() - chat.startedAt;
  chat.task.output = chat.output.slice(-12000);
  if (error) chat.task.error = error;
  systemNotify(chat.task.petName || 'Agent', chat.task.brief + ' · ' + (chat.task.status === 'done' ? '已完成' : (chat.task.status === 'cancelled' ? '已中断' : '失败')), chat.task.status === 'done' ? 'completion' : 'error', chat.task.id);
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
  return releaseFinishedThread(chat.threadId);
}

function releaseFinishedThread(threadId) {
  loadedThreads.delete(threadId);
  return Promise.resolve(appServer.unsubscribeThread({ threadId }))
    .catch(error => cfg.log('thread unsubscribe failed: ' + error.message))
    .finally(() => {
      clearTimeout(appServerIdleTimer);
      appServerIdleTimer = setTimeout(() => {
        if (!liveChats.size && !startingChats.size) appServer.stop();
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
  systemNotify(entry.title, entry.reason, 'attention', 'interaction-' + entry.id);
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

function scheduleAppServerIdleStop(delayMs = 150) {
  clearTimeout(appServerIdleTimer);
  appServerIdleTimer = setTimeout(() => {
    if (!liveChats.size && !startingChats.size) appServer.stop();
  }, delayMs);
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
  const eventTurnId = params.turnId || (params.turn && params.turn.id);
  if (eventTurnId && chat.turnId && eventTurnId !== chat.turnId) return;

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
  if (proj.archived) return { ok: false, error: '这个项目已归档，请先恢复项目。' };
  const pet = petRoster().find(item => item.id === petId);
  if (!pet) return { ok: false, error: '找不到这个 Agent。' };
  const text = String(taskText || '').trim();
  if (!text) return { ok: false, error: '消息不能为空。' };

  const cap = state.caps[pet.id];
  const used = petSessionTokens.get(pet.id) || 0;
  if (cap && used >= cap) return { ok: false, error: '这个 Agent 已达到你设置的用量上限。' };

  const key = proj.id + ':' + pet.id;
  const existingThread = petThreads.get(key);
  if (startingChats.has(key) || (existingThread && liveChats.has(existingThread))) return { ok: false, error: pet.name + ' 正在处理上一条消息。' };
  startingChats.add(key);
  clearTimeout(appServerIdleTimer);

  let threadId = existingThread;
  let recoveredArchivedThreadId = null;
  const archivedThreadError = error => /(?:session|thread).*\barchived\b|\bcodex\s+unarchive\b/i.test(String(error && error.message));
  const rateLimitError = error => /\b429\b|too many requests|exceeded retry limit|rate.?limit/i.test(String(error && error.message));
  const forgetCurrentThread = async staleThreadId => {
    if (!staleThreadId) return;
    loadedThreads.delete(staleThreadId);
    if (petThreads.get(key) === staleThreadId) petThreads.delete(key);
    state.conversations = Object.fromEntries(petThreads);
    cfg.saveState(state);
    try { await appServer.unsubscribeThread({ threadId: staleThreadId }); }
    catch (error) { cfg.log('stale thread unsubscribe failed: ' + error.message); }
  };
  const createFreshThread = async () => {
    const thread = await appServer.startThread({ cwd: proj.path, model: model || pet.model || null, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    const freshThreadId = thread.threadId;
    if (!freshThreadId) throw new Error('Codex App Server 未返回 threadId');
    petThreads.set(key, freshThreadId);
    loadedThreads.add(freshThreadId);
    state.conversations = Object.fromEntries(petThreads);
    cfg.saveState(state);
    proj.threadIds = Array.isArray(proj.threadIds) ? proj.threadIds : [];
    if (!proj.threadIds.includes(freshThreadId)) proj.threadIds.push(freshThreadId);
    proj.threadIds = proj.threadIds.slice(-30);
    proj.updatedAt = Date.now();
    try {
      await appServer.setThreadName({ threadId: freshThreadId, name: text.replace(/\s+/g, ' ').slice(0, 60) });
    } catch (error) {
      cfg.log('thread name failed: ' + error.message);
    }
    return freshThreadId;
  };
  try {
    if (threadId && !loadedThreads.has(threadId)) {
      try {
        await appServer.resumeThread({ threadId, cwd: proj.path, model: model || pet.model || null });
        loadedThreads.add(threadId);
      } catch (error) {
        if (archivedThreadError(error)) {
          cfg.log('saved thread is archived; creating a replacement: ' + threadId);
          recoveredArchivedThreadId = threadId;
          await forgetCurrentThread(threadId);
          threadId = null;
        } else {
        // Codex Desktop and Pet Office cannot both be the writer of one thread.
        // Never silently fork here: the user must explicitly choose a new
        // conversation so context ownership remains understandable.
          if (!/active writer|already has .*writer/i.test(String(error && error.message))) throw error;
          cfg.log('saved thread is owned by Codex Desktop: ' + threadId);
          scheduleAppServerIdleStop();
          return {
            ok: false,
            code: 'THREAD_OWNED_BY_CODEX',
            threadId,
            error: '这个会话当前由 Codex Desktop 控制。请在 Codex 中继续，或选择“新建会话”后再发送。',
          };
        }
      }
    }
    if (!threadId) {
      threadId = await createFreshThread();
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
    let result;
    try {
      result = await appServer.startTurn({ threadId, text, model: task.model });
    } catch (error) {
      if (!archivedThreadError(error) || threadId !== existingThread) throw error;
      const staleThreadId = threadId;
      recoveredArchivedThreadId = staleThreadId;
      liveChats.delete(staleThreadId);
      await forgetCurrentThread(staleThreadId);
      threadId = await createFreshThread();
      task.threadId = threadId;
      chat.threadId = threadId;
      liveChats.set(threadId, chat);
      persistStandaloneTask(task);
      cfg.log('archived thread replaced before turn start: ' + staleThreadId + ' -> ' + threadId);
      result = await appServer.startTurn({ threadId, text, model: task.model });
    }
    send('chat:event', {
      type: 'started', taskId: task.id, petId: pet.id, threadId, text,
      recoveredArchivedThreadId,
    });
    chat.turnId = (result && (result.turnId || (result.turn && result.turn.id))) || null;
    if (chat.cancelRequested) {
      if (chat.turnId) await appServer.interruptTurn({ threadId, turnId: chat.turnId });
      return { ok: false, error: '任务已取消。' };
    }
    chat.task.turnId = chat.turnId;
    persistStandaloneTask(chat.task);
    cfg.saveState(state);
    return { ok: true, taskId: task.id, threadId, turnId: chat.turnId };
  } catch (error) {
    const message = rateLimitError(error)
      ? '请求过于频繁，服务端已临时限流（429）。请稍候再发送；Pet Office 不会自动重复提交这条消息。'
      : error.message;
    const chat = threadId && liveChats.get(threadId);
    if (chat) finishChat(chat, 'failed', message);
    else {
      send('chat:event', { type: 'failed', petId: pet.id, threadId: threadId || null, error: message });
      scheduleAppServerIdleStop();
    }
    return { ok: false, code: rateLimitError(error) ? 'RATE_LIMITED' : undefined, error: message };
  } finally {
    startingChats.delete(key);
  }
}

async function cancelPetChat(taskId) {
  const chat = chatForTask(taskId);
  if (!chat) return false;
  chat.cancelRequested = true;
  try {
    if (chat.turnId) await appServer.interruptTurn({ threadId: chat.threadId, turnId: chat.turnId });
  } catch (error) {
    cfg.log('chat interrupt failed: ' + error.message);
  }
  finishChat(chat, 'interrupted', '已取消');
  return true;
}

function conversationKey(projectId, petId) {
  return String(projectId || '') + ':' + String(petId || '');
}

function resetPetConversation({ projectId, petId }) {
  const proj = projectId ? state.projects.find(project => project.id === projectId) : activeProject();
  if (!proj) return { ok: false, error: '还没有项目。请先新建或选择一个项目。' };
  const key = conversationKey(proj.id, petId);
  const threadId = petThreads.get(key);
  if (threadId && liveChats.has(threadId)) return { ok: false, code: 'CHAT_RUNNING', error: '这个 Agent 仍在工作，完成或取消后才能新建会话。' };
  petThreads.delete(key);
  if (threadId && loadedThreads.has(threadId)) {
    loadedThreads.delete(threadId);
    Promise.resolve(appServer.unsubscribeThread({ threadId }))
      .catch(error => cfg.log('new-conversation unsubscribe failed: ' + error.message));
    scheduleAppServerIdleStop();
  }
  state.conversations = Object.fromEntries(petThreads);
  cfg.saveState(state);
  return { ok: true, previousThreadId: threadId || null };
}

async function handoffPetChat(taskId) {
  const chat = chatForTask(taskId);
  if (!chat) return { ok: false, error: '任务已经结束或不再由桌宠控制。' };
  try {
    if (chat.turnId) await appServer.interruptTurn({ threadId: chat.threadId, turnId: chat.turnId });
  } catch (error) {
    cfg.log('handoff interrupt failed: ' + error.message);
  }
  chat.task.progress = '已停止当前回合，交给 Codex Desktop 继续';
  chat.task.progressStage = 'warning';
  await Promise.resolve(finishChat(chat, 'interrupted'));
  if (!liveChats.size) appServer.stop();
  try { await shell.openExternal('codex://threads/' + chat.threadId); } catch { await shell.openExternal('codex://').catch(() => {}); }
  return { ok: true, threadId: chat.threadId };
}

async function startDelegation({ taskText, projectId, participants }) {
  // Compatibility entry points use the same confirmation gate as the UI.
  return missionManager.createDraft({ taskText, projectId, participants });
}

// Every dispatcher task belongs to a Mission; the legacy batch flow is gone.
function onTaskEvent(ev) {
  if (!missionManager.handleTaskEvent(ev)) cfg.log('dispatcher event for unknown task ignored: ' + ev.taskId);
}

function onBridgeOrder(order) {
  cfg.log('bridge order: ' + order.action);
  try {
    if (order.action === 'delegate') {
      let proj = null;
      if (order.project) {
        const requested = String(order.project);
        proj = state.projects.find(p => p.id === requested || p.name === requested
          || (path.isAbsolute(requested) && path.resolve(p.path) === path.resolve(requested)));
        // Any local process can drop a bridge order, so it may only target
        // folders the user already added; new folders are created by name only.
        if (!proj && path.isAbsolute(requested)) {
          bridge.writeResult('bridge-error', '桥接任务只能使用已在 Pet Office 中添加的项目目录：' + requested, null);
          return;
        }
        if (!proj) proj = createProjectDir(safeName(requested));
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
      startDelegation({ taskText: order.task || '(无任务描述)', projectId: proj.id, participants, usePlanner: order.usePlanner !== false })
        .then(result => bridge.writeResult(result.ok ? 'bridge-ack' : 'bridge-error', result.ok
          ? 'Ruflo 计划已生成，等待在 Pet Office 中确认：' + result.mission.id
          : 'Ruflo 任务未建立：' + result.error, { acceptedAt: Date.now(), project: proj.name, missionId: result.mission && result.mission.id }))
        .catch(error => bridge.writeResult('bridge-error', String(error && error.message || error), null));
    } else if (order.action === 'message') {
      send('pet:message', { text: String(order.text || '') });
      bridge.writeResult('message-ack', '桌宠已显示消息: ' + order.text, null);
    } else if (order.action === 'status') {
      const snap = missionManager.snapshot().slice(0, 5).map(m => ({ id: m.id, project: m.projectName, task: m.objective, status: m.status, tasks: (m.tasks || []).map(t => (t.assigneeName || t.assigneePetId) + ':' + t.status) }));
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

function normalizedCaptureShortcut(value) {
  return CAPTURE_SHORTCUTS.has(value) ? value : 'Control+Alt+S';
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
  const captureRequested = normalizedCaptureShortcut(state.settings.captureShortcut);
  state.settings.captureShortcut = captureRequested;
  let captureActive = captureRequested;
  let captureOk = false;
  try { captureOk = globalShortcut.register(captureRequested, () => startScreenCapture('supervisor')); } catch {}
  if (!captureOk && captureRequested !== 'Control+Alt+S') {
    captureActive = 'Control+Alt+S';
    try { captureOk = globalShortcut.register(captureActive, () => startScreenCapture('supervisor')); } catch {}
  }
  try {
    globalShortcut.register('Control+Alt+Q', () => { isQuitting = true; app.quit(); });
  } catch {}
  shortcutStatus = {
    ok, requested, active: ok ? active : null, fallback: ok && active !== requested,
    captureOk, captureRequested, captureActive: captureOk ? captureActive : null, captureFallback: captureOk && captureActive !== captureRequested,
  };
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
    if ((state.settings.displayMode || 'cursor') === 'cursor') repositionWindow();
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setOpacity(fullscreenActive && state.settings.fullscreenBehavior === 'hide' ? 0 : 1); } catch {}
    send('pet:window-visible', true);
  } else {
    win.hide();
    send('pet:window-visible', false);
  }
}

function captureFingerprint(image) {
  if (!image || image.isEmpty()) return null;
  try { return crypto.createHash('sha256').update(image.toPNG()).digest('hex'); } catch { return null; }
}

function saveCapturedImage(image) {
  let project = activeProject();
  if (!project) project = createProjectDir('快速提问-' + new Date().toISOString().slice(0, 10));
  const dir = workspacePath(project.path, path.join('inbox', 'screenshots'));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(dir, 'screenshot-' + stamp + '.png');
  let suffix = 1;
  while (fs.existsSync(target)) target = path.join(dir, 'screenshot-' + stamp + '-' + suffix++ + '.png');
  const png = image.toPNG();
  workspacePath(project.path, path.relative(project.path, target));
  fs.writeFileSync(target, png, { flag: 'wx' });
  const size = image.getSize();
  const previewWidth = Math.min(360, Math.max(1, size.width));
  const preview = size.width > previewWidth ? image.resize({ width: previewWidth, quality: 'good' }) : image;
  project.updatedAt = Date.now();
  cfg.saveState(state);
  return {
    project: { id: project.id, name: project.name, path: project.path },
    file: {
      type: 'file', source: 'capture', projectId: project.id, name: path.basename(target), path: target,
      relPath: path.relative(project.path, target).split(path.sep).join('/'), kind: '图片', size: png.length,
      width: size.width, height: size.height, previewDataUrl: preview.toDataURL(),
    },
  };
}

async function startScreenCapture(petId = 'supervisor') {
  if (captureInFlight) {
    // Windows does not report an Esc cancellation through ms-screenclip. A new
    // request therefore supersedes the stale waiter instead of locking capture
    // for the full timeout.
    if (cancelCaptureWait) cancelCaptureWait('superseded');
    send('capture:status', { phase: 'restarting', petId, message: '已结束上一次截图等待，正在重新启动。' });
  }
  const captureId = ++captureEpoch;
  captureInFlight = true;
  const wasVisible = !!(win && win.isVisible());
  const baseline = captureFingerprint(clipboard.readImage());
  send('capture:status', { phase: 'starting', petId, message: '请选择要截取的区域；按 Esc 可取消。' });
  if (win && !win.isDestroyed()) win.hide();
  await new Promise(resolve => setTimeout(resolve, 180));
  try {
    await shell.openExternal('ms-screenclip:');
  } catch (error) {
    if (captureId !== captureEpoch) return { ok: false, cancelled: true, superseded: true };
    if (captureId === captureEpoch) {
      captureInFlight = false;
      cancelCaptureWait = null;
    }
    if (wasVisible) setWindowVisible(true);
    send('capture:status', { phase: 'failed', petId, message: '无法启动 Windows 截图：' + error.message });
    return { ok: false, error: error.message };
  }
  if (captureId !== captureEpoch) return { ok: false, cancelled: true, superseded: true };
  // Windows freezes the desktop image before the selection UI appears. Restore the
  // pet shortly afterwards so cancelling with Esc never leaves the app hidden.
  if (wasVisible) setTimeout(() => {
    if (captureInFlight && win && !win.isDestroyed() && !win.isVisible()) setWindowVisible(true);
  }, 1100);
  const startedAt = Date.now();
  const result = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (captureId === captureEpoch) cancelCaptureWait = null;
      resolve(value);
    };
    const timer = setInterval(() => {
      const image = clipboard.readImage();
      const fingerprint = captureFingerprint(image);
      if (fingerprint && fingerprint !== baseline) {
        finish({ image });
      } else if (Date.now() - startedAt > 30000) {
        finish(null);
      }
    }, 350);
    cancelCaptureWait = reason => finish({ cancelled: true, reason });
  });
  if (captureId !== captureEpoch || (result && result.reason === 'superseded')) {
    return { ok: false, cancelled: true, superseded: true };
  }
  captureInFlight = false;
  cancelCaptureWait = null;
  if (!result) {
    if (wasVisible) setWindowVisible(true);
    send('capture:status', { phase: 'cancelled', petId, message: '截图已取消或超时。' });
    return { ok: false, cancelled: true };
  }
  try {
    const saved = saveCapturedImage(result.image);
    setWindowVisible(true);
    send('capture:ready', { petId, ...saved });
    return { ok: true, ...saved };
  } catch (error) {
    if (wasVisible) setWindowVisible(true);
    send('capture:status', { phase: 'failed', petId, message: '截图保存失败：' + error.message });
    return { ok: false, error: error.message };
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
  const display = selectedDisplay();
  const wa = display.workArea;
  activeDisplayId = String(display.id);
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
  win.on('unresponsive', () => { writeCrashReport('renderer-unresponsive', 'Renderer did not respond', { activeDisplayId }); });
  win.webContents.on('render-process-gone', (event, details) => {
    writeCrashReport('renderer-gone', details.reason || 'renderer gone', { exitCode: details.exitCode, reason: details.reason });
    if (!isQuitting) setTimeout(() => { try { win.reload(); } catch {} }, 800);
  });
  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const action = captureScript(captureView);
          const actionResult = await win.webContents.executeJavaScript(action);
          const captureState = await win.webContents.executeJavaScript(CAPTURE_STATE_SCRIPT);
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
if (captureMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}
const gotLock = captureMode || app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

app.whenReady().then(() => {
  missionManager.load();
  if (captureMode) desktopMonitor.start();
  createWindow();
  if (captureMode) return;
  setTimeout(() => desktopMonitor.start(), 50);
  createTray();
  dispatcher.setConcurrency(state.settings.maxParallel);
  dispatcher.setEmitter(onTaskEvent);
  bridge.setHandler(onBridgeOrder);
  bridge.startWatching();
  screen.on('display-added', repositionWindow);
  screen.on('display-removed', repositionWindow);
  screen.on('display-metrics-changed', repositionWindow);
  configureFullscreenMonitor();
  refreshQuotas(true);
  setInterval(() => refreshQuotas(false), Math.max(30, state.settings.quotaPollSec) * 1000);
  applyAutostart();
  registerGlobalShortcuts();
  releaseManager.inspectWindowsSignature(process.execPath).then(signature => {
    releaseCache.signature = signature;
    send('release:update', releaseCache);
  });
  if (state.settings.autoCheckUpdates) setTimeout(() => checkForUpdates(false), 10000);
  if (process.argv.includes('--hidden')) setTimeout(() => setWindowVisible(false), 800);
});

app.on('second-instance', () => setWindowVisible(true));
app.on('before-quit', () => {
  isQuitting = true;
  clearInterval(fullscreenTimer);
  try { stopForegroundProbe(); } catch {}
  try { desktopMonitor.stop(); } catch {}
  try { appServer.stop(); } catch {}
  try { missionManager.shutdown(); } catch {}
  try { ruflo.shutdown(); } catch {}
  try { dispatcher.shutdown(); } catch {}
  try { planner.shutdown(); } catch {}
  try { bridge.stopWatching(); } catch {}
  try { cfg.flushState(); } catch {}
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
  for (const id of missionManager.threadIds()) ids.add(id);
  return ids;
}

function activeTasksSnapshot() {
  const merged = new Map((state.history || []).map(task => [task.id, { ...task, source: localTaskSource(task) }]));
  for (const task of missionManager.taskSnapshots()) merged.set(task.id, task);
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
      modelMode: p.modelMode || (r && r.modelMode) || ((hasExplicitModel ? p.model : (r && r.model)) ? 'locked' : 'auto'),
      use: !!p.use,
    };
  });
  return startDelegation({ taskText: payload.taskText, projectId: payload.projectId, participants, usePlanner: !!payload.usePlanner });
});
ipcMain.handle('mission:createDraft', async (e, payload = {}) => missionManager.createDraft(payload));
ipcMain.handle('mission:confirm', (e, id) => missionManager.confirm(id));
ipcMain.handle('mission:regenerate', async (e, id) => missionManager.regenerate(id));
ipcMain.handle('mission:cancel', (e, id) => missionManager.cancel(id));
ipcMain.handle('mission:cancelTask', (e, payload = {}) => missionManager.cancelTask(payload.missionId, payload.taskId));
ipcMain.handle('mission:resume', async (e, payload) => missionManager.resume(typeof payload === 'string' ? payload : payload.id, !!(payload && payload.allowReplay), !!(payload && payload.sandboxFallback)));
ipcMain.handle('mission:openArtifact', async (e, payload = {}) => {
  try {
    const file = missionManager.artifactPath(payload.missionId, payload.relativePath);
    if (!file) return { ok: false, error: '产物不存在或不在本 Mission 的交付范围内。' };
    const error = await shell.openPath(file);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('mission:list', () => missionManager.snapshot());
ipcMain.handle('mission:get', (e, id) => missionManager.get(id));
ipcMain.handle('mission:resolveConflict', (e, payload = {}) => missionManager.resolveConflict(payload.missionId, payload.action));
ipcMain.handle('mission:cloneLegacy', (e, id) => missionManager.cloneLegacy(id));
ipcMain.handle('mission:publishMemory', (e, id) => missionManager.publishMemory(id));
ipcMain.handle('ruflo:health', (e, projectId) => ruflo.health(projectId || state.activeProjectId, { probe: true }));
ipcMain.handle('ruflo:install', async () => {
  try {
    const health = await ruflo.install({ onProgress: message => message && send('ruflo:status', { state: 'installing', message }) });
    return { ok: true, health };
  } catch (error) {
    cfg.log('ruflo install failed: ' + error.message);
    return { ok: false, error: error.message, health: await ruflo.health(state.activeProjectId) };
  }
});
ipcMain.handle('ruflo:repair', async () => {
  try {
    const health = await ruflo.repair({ onProgress: message => message && send('ruflo:status', { state: 'repairing', message }) });
    return { ok: true, health };
  } catch (error) {
    cfg.log('ruflo repair failed: ' + error.message);
    return { ok: false, error: error.message, health: await ruflo.health(state.activeProjectId) };
  }
});
ipcMain.handle('chat:start', async (e, payload) => startPetChat(payload || {}));
ipcMain.handle('chat:new', (e, payload) => resetPetConversation(payload || {}));
ipcMain.handle('chat:reset', (e, payload) => resetPetConversation(payload || {}));
ipcMain.handle('chat:sessions', (e, projectId) => projectSessions(projectId || state.activeProjectId));
ipcMain.handle('chat:handoff', async (e, taskId) => handoffPetChat(taskId));
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
ipcMain.handle('project:select', (e, id) => {
  const project = projectById(id);
  if (!project || project.archived) return false;
  state.activeProjectId = id;
  project.updatedAt = Date.now();
  cfg.saveState(state);
  return true;
});
ipcMain.handle('project:rename', (e, payload = {}) => {
  const project = projectById(payload.id);
  const name = String(payload.name || '').trim().slice(0, 80);
  if (!project || !name) return { ok: false, error: '项目不存在或名称为空。' };
  project.name = name;
  project.updatedAt = Date.now();
  cfg.saveState(state);
  return { ok: true, project: { ...project } };
});
ipcMain.handle('project:archive', (e, payload = {}) => {
  const project = projectById(payload.id);
  if (!project) return { ok: false, error: '项目不存在。' };
  if (payload.archived !== false) {
    const busy = projectBusy(project.id);
    if (busy.busy) return { ok: false, error: busy.reason };
  }
  project.archived = payload.archived !== false;
  project.updatedAt = Date.now();
  if (project.archived && state.activeProjectId === project.id) state.activeProjectId = (nextActiveProject(project.id) || {}).id || null;
  if (!project.archived && !state.activeProjectId) state.activeProjectId = project.id;
  cfg.saveState(state);
  return { ok: true, project: { ...project }, activeProjectId: state.activeProjectId };
});
ipcMain.handle('project:remove', (e, id) => {
  const project = projectById(id);
  if (!project) return { ok: false, error: '项目不存在。' };
  const busy = projectBusy(project.id);
  if (busy.busy) return { ok: false, error: busy.reason };
  for (const key of [...petThreads.keys()]) if (key.startsWith(project.id + ':')) petThreads.delete(key);
  state.conversations = Object.fromEntries(petThreads);
  state.projects = state.projects.filter(item => item.id !== project.id);
  if (state.activeProjectId === project.id) state.activeProjectId = (nextActiveProject() || {}).id || null;
  if (state.ui.taskProjectFilter === project.id) state.ui.taskProjectFilter = 'all';
  cfg.saveState(state);
  return { ok: true, removedId: project.id, preservedPath: project.path, activeProjectId: state.activeProjectId };
});
ipcMain.handle('project:clearAttachments', (e, id) => {
  const project = projectById(id);
  if (!project) return { ok: false, error: '项目不存在。' };
  try {
    const result = clearProjectInbox(project.path);
    project.updatedAt = Date.now();
    cfg.saveState(state);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('agents:recommend', (e, payload = {}) => recommendAgents({
  taskText: payload.taskText,
  workers: state.pets.workers.map(worker => ({ id: worker.id, name: worker.name, model: worker.model || null })),
  models: catalog.loadModels(),
  max: Math.min(4, state.settings.maxParallel || 4),
}));
ipcMain.handle('settings:set', (e, patch) => {
  const previousShortcut = state.settings.toggleShortcut;
  const previousCaptureShortcut = state.settings.captureShortcut;
  const previousDisplay = state.settings.displayMode;
  const previousFullscreen = state.settings.fullscreenBehavior;
  Object.assign(state.settings, pickKeys(patch, RENDERER_SETTINGS));
  state.settings.autostart = !!state.settings.autostart;
  state.settings.themeMode = ['warm', 'dark', 'system'].includes(state.settings.themeMode) ? state.settings.themeMode : 'warm';
  state.settings.delegationEngine = delegationEngine(state.settings.delegationEngine);
  state.settings.maxParallel = Math.max(1, Math.min(5, Number(state.settings.maxParallel) || 5));
  state.settings.petScale = Math.max(0.8, Math.min(1.4, Number(state.settings.petScale) || 1));
  state.settings.compactMode = !!state.settings.compactMode;
  state.settings.reducedMotion = !!state.settings.reducedMotion;
  state.settings.notificationMode = ['quiet', 'standard', 'detailed'].includes(state.settings.notificationMode) ? state.settings.notificationMode : 'standard';
  state.settings.fullscreenBehavior = ['corner', 'hide', 'ignore'].includes(state.settings.fullscreenBehavior) ? state.settings.fullscreenBehavior : 'corner';
  state.settings.fontScale = [0.9, 1, 1.1, 1.2].includes(Number(state.settings.fontScale)) ? Number(state.settings.fontScale) : 1;
  state.settings.fontFamily = ['system', 'rounded', 'readable'].includes(state.settings.fontFamily) ? state.settings.fontFamily : 'system';
  state.settings.autoCheckUpdates = state.settings.autoCheckUpdates !== false;
  const allowedDisplays = new Set(['cursor', 'primary', ...displaySnapshot().map(display => display.id)]);
  state.settings.displayMode = allowedDisplays.has(String(state.settings.displayMode)) ? String(state.settings.displayMode) : 'cursor';
  state.settings.toggleShortcut = normalizedToggleShortcut(state.settings.toggleShortcut);
  state.settings.captureShortcut = normalizedCaptureShortcut(state.settings.captureShortcut);
  if (app.isReady() && (state.settings.toggleShortcut !== previousShortcut || state.settings.captureShortcut !== previousCaptureShortcut)) registerGlobalShortcuts();
  if (app.isReady() && state.settings.displayMode !== previousDisplay) repositionWindow();
  if (app.isReady() && state.settings.fullscreenBehavior !== previousFullscreen) configureFullscreenMonitor();
  cfg.saveState(state);
  dispatcher.setConcurrency(state.settings.maxParallel);
  applyAutostart();
  return publicState();
});
ipcMain.handle('ui:set', (e, patch) => {
  Object.assign(state.ui, pickKeys(patch, RENDERER_UI));
  if (!Array.isArray(state.ui.hiddenPets)) state.ui.hiddenPets = [];
  if (!state.ui.petPositions || typeof state.ui.petPositions !== 'object' || Array.isArray(state.ui.petPositions)) state.ui.petPositions = {};
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
ipcMain.handle('pet:model', (e, { petId, model, mode }) => {
  const m = model || null;
  const modelMode = mode === 'auto' || mode === 'locked' ? mode : (m ? 'locked' : 'auto');
  if (petId === 'supervisor') { state.pets.supervisor.model = m; state.pets.supervisor.modelMode = modelMode; }
  else { const w = state.pets.workers.find(x => x.id === petId); if (w) { w.model = m; w.modelMode = modelMode; } }
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
ipcMain.handle('shell:open', async (e, p) => {
  const roots = [...state.projects.map(project => project.path), cfg.DIRS.runtime, cfg.DIRS.fromPets];
  let target = null;
  try { target = openablePath(p, roots); } catch {}
  if (!target) {
    cfg.log('shell:open refused a path outside trusted roots or an executable file');
    return '只能打开项目或 Pet Office 运行目录中的文件夹与文档。';
  }
  try { return await shell.openPath(target); } catch (error) { return error.message; }
});
ipcMain.handle('shell:external', async (e, url) => {
  const normalized = normalizeDroppedLinks({ plain: String(url || '') })[0];
  if (!normalized) return false;
  try { await shell.openExternal(normalized.url); return true; } catch { return false; }
});
ipcMain.handle('links:normalize', (e, payload = {}) => normalizeDroppedLinks(payload));
ipcMain.handle('capture:start', (e, petId) => startScreenCapture(String(petId || 'supervisor')));
ipcMain.handle('files:ingest', async (e, payload = {}) => {
  const paths = Array.isArray(payload.paths) ? payload.paths : [];
  let proj = payload.projectId ? state.projects.find(item => item.id === payload.projectId) : activeProject();
  if (payload.projectId && (!proj || proj.archived)) return { ok: false, files: [], error: '目标项目不存在或已归档。' };
  if (!proj) {
    const stamp = new Date().toISOString().slice(0, 10);
    proj = createProjectDir('上传-' + stamp);
    cfg.log('files:ingest created project ' + proj.name);
  }
  const result = await inbox.ingestFilesAsync({
    paths,
    projectPath: proj.path,
    onProgress: progress => send('files:progress', { ...progress, projectId: proj.id, projectName: proj.name }),
  });
  cfg.log('files:ingest ' + JSON.stringify({ received: result.files.length, skipped: result.skipped.length, project: proj.name }));
  return { ...result, files: result.files.map(file => ({ ...file, projectId: proj.id })), project: { id: proj.id, name: proj.name, path: proj.path } };
});
ipcMain.handle('codex:open', async (e, threadId) => {
  const live = threadId && liveChats.get(threadId);
  if (live) {
    return {
      ok: false,
      code: 'ACTIVE_PET_CHAT',
      taskId: live.task.id,
      threadId,
      error: '这个任务正在由桌宠执行。若要在 Codex 中继续，需要先移交并停止当前回合。',
    };
  }
  const missionOwner = threadId && missionManager.threadOwner(threadId);
  if (missionOwner && missionOwner.locked) {
    return {
      ok: false,
      code: 'ACTIVE_MISSION',
      missionId: missionOwner.missionId,
      threadId,
      error: missionOwner.role === 'supervisor'
        ? '主管任务正在由 Pet Office 管理。Mission 结束前请在任务中心查看记录，避免 Codex Desktop 占用同一任务。'
        : '这个 Mission 节点仍在执行。完成后才能在 Codex Desktop 中打开。',
    };
  }
  if (threadId && !liveChats.size && appServer.child) {
    appServer.stop();
    loadedThreads.clear();
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  const url = threadId ? 'codex://threads/' + threadId : 'codex://';
  try { await shell.openExternal(url); } catch { try { await shell.openExternal('codex://'); } catch {} }
  return { ok: true, threadId: threadId || null };
});
ipcMain.handle('petdex:open', async () => {
  try { await shell.openExternal('https://petdex.dev/'); } catch {}
  return true;
});
ipcMain.handle('quota:refresh', async () => { await refreshQuotas(true); return quotaCache; });
ipcMain.handle('diagnostics:get', async () => {
  const engine = state.settings.delegationEngine;
  let rufloHealth = null;
  // Probing Ruflo spawns Node, npm and an MCP server; only do it when the user
  // actually chose that engine.
  if (engine === 'ruflo') {
    try { rufloHealth = await ruflo.health(state.activeProjectId, { probe: true }); }
    catch (error) { rufloHealth = { ready: false, state: 'error', checks: { mcp: { ok: false, value: error.message } } }; }
  }
  return diagnostics.collectDiagnostics({
    appServerHealth: appServer.health(),
    desktopMonitorHealth,
    quotaCache,
    rufloHealth,
    delegationEngine: engine,
  });
});
ipcMain.handle('desktop:displays', () => ({ displays: displaySnapshot(), activeDisplayId, fullscreenActive }));
ipcMain.handle('release:check', () => checkForUpdates(true));
ipcMain.handle('release:open', async () => {
  const target = releaseCache.update && (releaseCache.update.releaseUrl || releaseCache.update.downloadUrl);
  try { await shell.openExternal(target || 'https://github.com/Gu-kai-lei/Open-Pet-Office/releases/latest'); return true; } catch { return false; }
});
ipcMain.handle('crash:status', () => {
  releaseCache.crashes = releaseManager.crashReportSummary(cfg.DIRS.crashes);
  return releaseCache.crashes;
});
ipcMain.handle('crash:open', () => shell.openPath(cfg.DIRS.crashes));
ipcMain.on('crash:renderer', (event, payload = {}) => {
  writeCrashReport('renderer-js', payload.stack || payload.message || 'Renderer error', { source: redactCrashText(payload.source), line: payload.line || null, column: payload.column || null });
});
ipcMain.handle('app:hide', () => { setWindowVisible(false); return true; });
ipcMain.handle('app:show', () => { setWindowVisible(true); return true; });
ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });
