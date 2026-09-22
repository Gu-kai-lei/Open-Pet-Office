'use strict';

const $ = selector => document.querySelector(selector);
const STATUS_TEXT = {
  idle: '待命', queued: '排队中', working: '工作中', done: '已完成',
  needs_input: '需要输入', failed: '出错', capped: '达用量上限', cancelled: '已取消', unknown: '状态未知',
};
const MISSION_STATUS_TEXT = {
  planning: '主管规划中', awaiting_confirmation: '等待确认', running: '执行中', reviewing: '主管检查中',
  needs_input: '需要处理', interrupted: '已中断', completed: '已完成', partially_succeeded: '部分成功', failed: '失败', cancelled: '已取消',
};

let S = null;
let delegationOn = false;
let tasks = [];
let missions = [];
let interactions = [];
let openPanelFor = null;
let tooltipTimer = null;
let dragState = null;
let composerPetId = null;
let composerCloseTimer = null;
let composerAttachments = [];
let composerSubmitting = false;
let diagnosticsReport = null;
let diagnosticsInFlight = false;
let fullscreenPetPosition = null;
let liveTaskHideTimer = null;
let lastPointer = { x: 0, y: 0 };
const activitySurface = { state: 'closed', epoch: 0, timer: null, animation: null };
const composerSurface = { epoch: 0, timer: null, animation: null };
const pets = new Map();
const panelTabs = new Map();
const temporarySummons = new Set();
const bubbleTimers = {};
const chatStreams = new Map();
const skinPreviewCache = new Map();
const previousTaskStatuses = new Map();
const projectSessionCache = new Map();
const projectSessionLoading = new Set();
const TERMINAL_PET_STATUSES = new Set(['done', 'failed', 'cancelled', 'capped', 'unknown']);
const TERMINAL_TASK_WINDOW_MS = 4000;
const STATUS_BADGE_MS = 4200;

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function short(value, length) {
  const text = String(value || '');
  return text.length > length ? text.slice(0, length) + '…' : text;
}

function tail(value, length) {
  const text = String(value || '');
  return text.length > length ? '…' + text.slice(-(length - 1)) : text;
}

function modelRecord(slug) {
  return (S.models || []).find(model => model.slug === slug) || null;
}

function providerOf(slug) {
  if (!slug) return 'openai';
  const record = modelRecord(slug);
  if (record && record.provider) return record.provider;
  return slug.includes('/') ? slug.split('/')[0] : 'openai';
}

function modelName(slug) {
  if (!slug) return 'Codex 默认';
  const record = modelRecord(slug);
  return record ? record.name : slug;
}

function capabilityLabels(slug) {
  const record = modelRecord(slug);
  const cap = record && record.capabilities;
  if (!cap) return [];
  const labels = [];
  if (cap.code) labels.push('代码');
  if (cap.vision) labels.push('视觉');
  if (cap.longContext) labels.push('长上下文');
  labels.push(cap.speed === 'fast' ? '快速' : (cap.speed === 'deliberate' ? '深度' : '均衡'));
  labels.push(({ free: '免费', low: '低成本', medium: '中等成本', high: '高成本' })[cap.cost] || '成本未知');
  return labels;
}

function capabilityBadges(slug, compact = false) {
  const labels = capabilityLabels(slug);
  if (!labels.length) return '<span class="capability-tags muted"><i>能力信息待同步</i></span>';
  return '<span class="capability-tags' + (compact ? ' compact' : '') + '">' + labels.map(label => '<i>' + esc(label) + '</i>').join('') + '</span>';
}

function skinRecord(slug) {
  return (S.skins || []).find(skin => skin.slug === slug) || null;
}

function providerLabel(provider) {
  const report = ((S.quotas || {}).reports || []).find(item => item.provider === provider);
  if (report && report.label) return report.label;
  return ({ openai: 'OpenAI', deepseek: 'DeepSeek' })[provider] || provider;
}

function statusForTask(status) {
  return ({ queued: 'queued', running: 'working', waiting_input: 'needs_input', done: 'done', failed: 'failed', cancelled: 'cancelled', capped: 'capped', unknown: 'unknown' })[status] || 'idle';
}

const SHORTCUT_OPTIONS = [
  ['Control+Alt+P', 'Ctrl + Alt + P'],
  ['Super+Alt+P', 'Win + Alt + P'],
  ['Control+Shift+P', 'Ctrl + Shift + P'],
  ['Alt+Shift+P', 'Alt + Shift + P'],
];
const CAPTURE_SHORTCUT_OPTIONS = [
  ['Control+Alt+S', 'Ctrl + Alt + S'],
  ['Super+Alt+S', 'Win + Alt + S'],
  ['Control+Shift+S', 'Ctrl + Shift + S'],
  ['Alt+Shift+S', 'Alt + Shift + S'],
];

function selectOptions(items, selected) {
  return items.map(item => '<option value="' + esc(item[0]) + '"' + (String(item[0]) === String(selected) ? ' selected' : '') + '>' + esc(item[1]) + '</option>').join('');
}

function displayOptions(selected) {
  const fixed = [['cursor', '跟随鼠标所在显示器'], ['primary', '始终使用主显示器']];
  const displays = ((S.desktop || {}).displays || []).map((display, index) => [String(display.id), display.label || ('显示器 ' + (index + 1))]);
  return selectOptions([...fixed, ...displays], selected || 'cursor');
}

function releaseHtml() {
  const release = S.release || {};
  const update = release.update;
  const signature = release.signature || {};
  const crashes = release.crashes || {};
  const updateText = !update ? '尚未检查更新'
    : (!update.ok ? ('检查失败 · ' + (update.error || '未知错误'))
      : (update.updateAvailable ? ('发现 v' + update.latestVersion) : '已是最新版本'));
  const signatureText = signature.signed ? '代码签名有效' : (signature.status === 'development' ? '开发模式' : '未检测到有效签名');
  return '<section class="release-card"><div class="release-head"><span><b>版本与可靠性</b><small>v' + esc(release.currentVersion || '0.13.3') + '</small></span><i class="' + (signature.signed ? 'valid' : '') + '">' + esc(signatureText) + '</i></div>' +
    '<div class="release-status"><span>' + esc(updateText) + '</span><span>本地崩溃记录 ' + Number(crashes.count || 0) + ' 条</span></div>' +
    '<div class="button-row"><button class="btn" id="p-check-update">检查更新</button>' + (update && update.ok && update.updateAvailable ? '<button class="btn primary" id="p-open-release">查看新版</button>' : '') + '<button class="btn" id="p-open-crashes">打开崩溃记录</button></div></section>';
}

function motionReduced() {
  return !!(S && S.settings && S.settings.reducedMotion);
}

function appearanceScale() {
  const base = Math.max(.8, Math.min(1.4, Number((S.settings || {}).petScale) || 1));
  return base * ((S.settings || {}).compactMode ? .78 : 1);
}

function applyAppearanceSettings() {
  const settings = S.settings || {};
  const themeMode = ['warm', 'dark', 'system'].includes(settings.themeMode) ? settings.themeMode : 'warm';
  document.body.classList.toggle('compact-mode', !!settings.compactMode);
  document.body.classList.toggle('reduce-motion', !!settings.reducedMotion);
  document.body.classList.toggle('theme-dark', themeMode === 'dark');
  document.body.classList.toggle('theme-system', themeMode === 'system');
  document.body.dataset.theme = themeMode;
  document.documentElement.style.colorScheme = themeMode === 'dark' ? 'dark' : (themeMode === 'system' ? 'light dark' : 'light');
  document.body.classList.toggle('font-rounded', settings.fontFamily === 'rounded');
  document.body.classList.toggle('font-readable', settings.fontFamily === 'readable');
  document.documentElement.style.setProperty('--pet-scale', appearanceScale().toFixed(3));
  document.documentElement.style.setProperty('--font-scale', String(Math.max(.9, Math.min(1.25, Number(settings.fontScale) || 1))));
  for (const pet of pets.values()) updateSkinState(pet);
}

function announce(text) {
  const region = $('#announcer');
  if (!region) return;
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = String(text || ''); });
}

init();

async function init() {
  S = await window.petOffice.getState();
  S.ui = S.ui || { delegationOn: false, hiddenPets: ['w1', 'w2', 'w3', 'w4'] };
  S.ui.hiddenPets = Array.isArray(S.ui.hiddenPets) ? S.ui.hiddenPets : [];
  S.ui.petPositions = S.ui.petPositions || {};
  delegationOn = !!S.ui.delegationOn;
  tasks = S.tasks || [];
  missions = S.missions || [];
  interactions = S.interactions || [];
  applyAppearanceSettings();
  buildPets();
  applyFullscreenMode({ active: !!(S.desktop && S.desktop.fullscreenActive), behavior: S.settings.fullscreenBehavior });
  updateActivityBadge();
  updateLiveTaskCard();
  bindEvents();

  document.addEventListener('pointermove', event => {
    lastPointer = { x: event.clientX, y: event.clientY };
    updatePetDrag(event);
    syncMouseCapture(event.target);
  });
  document.addEventListener('pointerup', finishPetDrag);
  document.addEventListener('pointercancel', finishPetDrag);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeOverlays();
    if (event.key === 'F6') {
      event.preventDefault();
      const list = [...pets.values()].map(pet => pet.el).filter(el => !el.classList.contains('hidden-pet'));
      const index = list.indexOf(document.activeElement);
      (list[(index + 1) % list.length] || list[0])?.focus();
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      openActivity();
    }
    if (event.ctrlKey && event.key === 'Enter' && !$('#composer').classList.contains('hidden')) {
      event.preventDefault();
      $('#c-send')?.click();
    }
    if (event.altKey && event.key.toLowerCase() === 'a' && !$('#composer').classList.contains('hidden')) {
      event.preventDefault();
      const toggle = $('#c-delegation');
      if (toggle) { toggle.checked = !toggle.checked; toggle.dispatchEvent(new Event('change')); }
    }
  });
  $('#stage').addEventListener('pointerdown', event => {
    if (!event.target.closest('.ui')) {
      closeOverlays();
      syncMouseCapture(event.target);
    }
  });
}

function overlayIsOpen() {
  return activitySurface.state !== 'closed' || ['#panel', '#ctxmenu', '#composer'].some(selector => !$(selector).classList.contains('hidden'));
}

function syncMouseCapture(target) {
  const interactive = !!(target && target.closest && target.closest('.ui'));
  window.petOffice.setMouseIgnore(!interactive && !overlayIsOpen());
}

function buildPets() {
  const roster = [
    { id: 'supervisor', role: 'supervisor', name: S.pets.supervisor.name, model: S.pets.supervisor.model, skin: S.pets.supervisor.skin },
    ...S.pets.workers.map(worker => ({ id: worker.id, role: 'worker', name: worker.name, model: worker.model, skin: worker.skin })),
  ];
  for (const pet of roster) pets.set(pet.id, createPet(pet));
}

function petHome(id) {
  const saved = S.ui && S.ui.petPositions && S.ui.petPositions[id];
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    return {
      x: Math.max(4, Math.min(innerWidth - 116 * appearanceScale(), saved.x)),
      y: Math.max(4, Math.min(innerHeight - 166 * appearanceScale(), saved.y)),
    };
  }
  const base = { x: Math.round(innerWidth * 0.76), y: Math.round(innerHeight - 295) };
  const offset = ({ supervisor: [0, 0], w1: [-170, 54], w2: [-86, 6], w3: [8, 54], w4: [95, 6] })[id] || [0, 0];
  return { x: base.x + offset[0], y: base.y + offset[1] };
}

function createPet(pet) {
  const element = document.createElement('div');
  const hidden = pet.role === 'worker' && S.ui.hiddenPets.includes(pet.id);
  element.className = 'pet ui ' + (pet.role === 'supervisor' ? 'boss' : 'worker') + (hidden ? ' hidden-pet' : '');
  element.id = 'pet-' + pet.id;
  element.tabIndex = 0;
  element.setAttribute('role', 'group');
  element.setAttribute('aria-roledescription', '桌宠');
  element.setAttribute('aria-label', pet.name + '，' + (pet.role === 'supervisor' ? '主管 Agent' : '工作者 Agent'));
  const activityButton = pet.role === 'supervisor'
    ? '<span class="quick-sep"></span><button class="quick-btn activity-btn" data-activity aria-label="任务动态" title="任务动态"><span class="bell-icon" aria-hidden="true"></span><i class="activity-badge hidden">0</i></button>'
    : '';
  element.innerHTML =
    '<div class="bubble hidden"></div>' +
    '<span class="state-signal" aria-hidden="true"></span>' +
    '<div class="body"><div class="skin-sprite"></div><div class="crown">' + (pet.role === 'supervisor' ? '👑' : '') + '</div>' +
    '<div class="screen"><span class="prompt-mark">›_</span></div>' +
    '<div class="face"><span class="eye l"></span><span class="eye r"></span><span class="blush l"></span><span class="blush r"></span><span class="mouth"></span></div>' +
    '<div class="feet"><span class="foot l"></span><span class="foot r"></span></div></div>' +
    '<div class="tag">' + esc(pet.name) + '<span class="dot"></span></div>' +
    '<div class="quickbar"><button class="quick-btn" data-quick-chat aria-label="输入消息" title="输入消息">✎</button>' + activityButton + '</div>';

  const home = petHome(pet.id);
  element.style.left = home.x + 'px';
  element.style.top = home.y + 'px';
  element.addEventListener('pointerdown', event => beginPetDrag(event, pet.id));
  element.addEventListener('click', event => {
    event.stopPropagation();
    const currentPet = pets.get(pet.id);
    if (currentPet && currentPet.suppressClickUntil > Date.now()) return;
    if (event.target.closest('[data-quick-chat]')) {
      openComposer(pet.id, delegationOn);
      return;
    }
    if (event.target.closest('[data-activity]')) {
      openActivity();
      return;
    }
    if (event.target.closest('.quickbar')) return;
    if (composerPetId === pet.id) closeComposer();
    openPanel(pet.id);
  });
  element.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(pet.id, event.clientX, event.clientY);
  });
  element.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (event.shiftKey) openComposer(pet.id, delegationOn);
    else openPanel(pet.id);
  });
  element.addEventListener('mouseenter', () => {
    clearTimeout(tooltipTimer);
    setSkinPose(pets.get(pet.id), 'hoverRow', SKIN_ROWS.wave);
    showTooltip(pet.id);
  });
  element.addEventListener('mouseleave', () => {
    setSkinPose(pets.get(pet.id), 'hoverRow', null);
    tooltipTimer = setTimeout(hideTooltip, 240);
  });
  $('#pets').appendChild(element);
  const created = { ...pet, el: element, status: 'idle', brief: '' };
  applySkin(created);
  return created;
}

function beginPetDrag(event, petId) {
  if (event.button !== 0 || event.target.closest('button,input,textarea,select,.quickbar')) return;
  const pet = pets.get(petId);
  if (!pet) return;
  dragState = {
    pet,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: parseFloat(pet.el.style.left) || 0,
    originY: parseFloat(pet.el.style.top) || 0,
    moved: false,
  };
  try { pet.el.setPointerCapture(event.pointerId); } catch {}
}

function updatePetDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
  if (!dragState.moved) {
    dragState.moved = true;
    dragState.pet.el.classList.add('dragging');
    $('#panel').classList.add('hidden');
    $('#ctxmenu').classList.add('hidden');
    if (composerPetId === dragState.pet.id) closeComposer(true);
  }
  setSkinPose(dragState.pet, 'walkRow', dx >= 0 ? SKIN_ROWS.runRight : SKIN_ROWS.runLeft);
  const rect = dragState.pet.el.getBoundingClientRect();
  const x = Math.max(4, Math.min(innerWidth - rect.width - 4, dragState.originX + dx));
  const y = Math.max(4, Math.min(innerHeight - rect.height - 4, dragState.originY + dy));
  dragState.pet.el.style.left = Math.round(x) + 'px';
  dragState.pet.el.style.top = Math.round(y) + 'px';
  positionLiveTaskCard();
  event.preventDefault();
}

function finishPetDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const { pet, moved } = dragState;
  try { pet.el.releasePointerCapture(event.pointerId); } catch {}
  pet.el.classList.remove('dragging');
  setSkinPose(pet, 'walkRow', null);
  if (moved) {
    pet.suppressClickUntil = Date.now() + 260;
    S.ui.petPositions = S.ui.petPositions || {};
    S.ui.petPositions[pet.id] = {
      x: Math.round(parseFloat(pet.el.style.left) || 0),
      y: Math.round(parseFloat(pet.el.style.top) || 0),
    };
    window.petOffice.setUi({ petPositions: S.ui.petPositions });
  }
  positionLiveTaskCard();
  dragState = null;
}

function clampPetsToViewport() {
  for (const pet of pets.values()) {
    const rect = pet.el.getBoundingClientRect();
    const scale = appearanceScale();
    const width = Math.max(70, rect.width || 116 * scale);
    const height = Math.max(90, rect.height || 166 * scale);
    pet.el.style.left = Math.max(4, Math.min(innerWidth - width - 4, parseFloat(pet.el.style.left) || 4)) + 'px';
    pet.el.style.top = Math.max(4, Math.min(innerHeight - height - 4, parseFloat(pet.el.style.top) || 4)) + 'px';
  }
  positionLiveTaskCard();
}

function applyFullscreenMode(payload = {}) {
  const active = !!payload.active;
  const behavior = payload.behavior || (S.settings || {}).fullscreenBehavior || 'corner';
  document.body.classList.toggle('fullscreen-corner', active && behavior === 'corner');
  const boss = pets.get('supervisor');
  if (!boss) return;
  if (active && behavior === 'corner') {
    if (!fullscreenPetPosition) fullscreenPetPosition = { left: boss.el.style.left, top: boss.el.style.top };
    closeOverlays();
    requestAnimationFrame(() => {
      const rect = boss.el.getBoundingClientRect();
      boss.el.style.left = Math.max(8, innerWidth - rect.width - 12) + 'px';
      boss.el.style.top = Math.max(8, innerHeight - rect.height - 12) + 'px';
    });
  } else if (fullscreenPetPosition) {
    boss.el.style.left = fullscreenPetPosition.left;
    boss.el.style.top = fullscreenPetPosition.top;
    fullscreenPetPosition = null;
    clampPetsToViewport();
  }
}

function bindEvents() {
  window.petOffice.on('task:event', onTaskEvent);
  window.petOffice.on('chat:event', onChatEvent);
  window.petOffice.on('task:snapshot', applyTaskSnapshot);
  window.petOffice.on('mission:snapshot', payload => {
    missions = Array.isArray(payload) ? payload : ((payload && payload.missions) || []);
    S.missions = missions;
    updateActivityBadge();
    updateLiveTaskCard();
    if (activitySurface.state !== 'closed') refreshActivityContents();
  });
  window.petOffice.on('mission:done', mission => {
    const label = mission.status === 'completed' ? 'Mission 已完成' : (mission.status === 'partially_succeeded' ? 'Mission 部分完成' : 'Mission 已结束');
    bubble('supervisor', label, 9000, mission.status === 'completed' ? 'completion' : 'attention');
    refreshState();
    setTimeout(restoreWorkerVisibility, 6000);
  });
  window.petOffice.on('interaction:update', items => {
    interactions = Array.isArray(items) ? items : [];
    updateActivityBadge();
    if (activitySurface.state !== 'closed') refreshActivityContents();
  });
  window.petOffice.on('batch:update', data => {
    const planningId = 'planning-' + data.batchId;
    if (data.phase === 'planning') {
      upsertTask({
        id: planningId, batchId: data.batchId, petId: 'supervisor', petName: pets.get('supervisor').name,
        projectId: data.projectId, projectName: data.projectName, brief: data.taskText || '正在规划分工任务',
        progress: '主管正在分析任务并拆分工作…', progressStage: 'thinking', status: 'running',
        kind: 'planning', startedAt: Date.now(), updatedAt: Date.now(),
      });
    } else {
      tasks = tasks.filter(task => task.id !== planningId);
    }
    if (Array.isArray(data.tasks)) data.tasks.forEach(upsertTask);
    if (data.phase === 'planning') bubble('supervisor', '正在分析任务、拆分简报…', 12000);
    if (data.phase === 'running') {
      const ids = (data.tasks || []).map(task => task.petId).filter(id => id !== 'supervisor');
      summonWorkers(ids, false);
      bubble('supervisor', '任务已分发，团队开工！', 5000);
    }
    updateLiveTaskCard();
    if (activitySurface.state !== 'closed') refreshActivityContents();
    if (data.phase !== 'planning') refreshState();
  });
  window.petOffice.on('batch:done', () => {
    bubble('supervisor', '✔ 团队结果已汇总', 10000);
    refreshState();
    setTimeout(restoreWorkerVisibility, 6000);
  });
  window.petOffice.on('quota:update', quotas => {
    S.quotas = quotas;
    if (openPanelFor && panelTabs.get(openPanelFor) === 'overview') refreshOpenPanelForLiveState();
  });
  window.petOffice.on('files:progress', progress => {
    if (!progress || progress.phase !== 'copied' || !composerPetId) return;
    bubble(composerPetId, '已复制 ' + progress.index + '/' + progress.total + ' · ' + short(progress.name, 36), 2200, 'detail');
  });
  window.petOffice.on('capture:status', payload => {
    if (!payload || payload.phase === 'starting') return;
    const target = pets.get(payload.petId) || pets.get('supervisor');
    bubble(target.id, payload.message || '截图未完成', 6500, payload.phase === 'failed' ? 'attention' : 'detail');
    announce(payload.message || '截图未完成');
  });
  window.petOffice.on('capture:ready', payload => {
    if (!payload || !payload.file) return;
    const target = pets.get(payload.petId) || pets.get('supervisor');
    if (payload.project) {
      S.projects = [...(S.projects || []).filter(item => item.id !== payload.project.id), payload.project];
      S.activeProjectId = payload.project.id;
    }
    const alreadyOpen = composerPetId === target.id && !$('#composer').classList.contains('hidden');
    if (!alreadyOpen) openComposer(target.id, false);
    const key = payload.file.path || payload.file.relPath || payload.file.name;
    if (!composerAttachments.some(item => (item.path || item.relPath || item.name) === key)) composerAttachments.push(payload.file);
    renderComposerFiles();
    const input = $('#c-text');
    if (input) {
      input.placeholder = '关于这张截图，你想问什么？';
      input.focus({ preventScroll: true });
    }
    bubble(target.id, '截图已附加，输入问题后发送', 6500, 'detail');
    announce('截图已附加，等待输入问题');
  });
  window.petOffice.on('pet:message', data => bubble('supervisor', data.text, 12000));
  window.petOffice.on('desktop:display', payload => {
    S.desktop = { ...(S.desktop || {}), ...(payload || {}) };
    requestAnimationFrame(clampPetsToViewport);
    if (openPanelFor && panelTabs.get(openPanelFor) === 'settings') openPanel(openPanelFor, 'settings');
  });
  window.petOffice.on('desktop:fullscreen', payload => {
    S.desktop = { ...(S.desktop || {}), fullscreenActive: !!(payload && payload.active) };
    applyFullscreenMode(payload);
  });
  window.petOffice.on('release:update', release => {
    S.release = release || S.release;
    if (release && release.update && release.update.updateAvailable) announce('Pet Office 有新版本可用');
    if (openPanelFor && panelTabs.get(openPanelFor) === 'settings') openPanel(openPanelFor, 'settings');
  });
  $('#live-task').onclick = event => {
    const pin = event.target.closest('[data-live-pin]');
    if (pin) {
      event.stopPropagation();
      setPinnedLiveTask(pin.dataset.livePin);
      return;
    }
    const threadId = $('#live-task').dataset.threadId;
    if (threadId) openCodexThread(threadId);
    else openActivity();
  };
  window.addEventListener('resize', clampPetsToViewport);
  window.addEventListener('error', event => window.petOffice.reportRendererCrash({ kind: 'renderer-error', message: event.message, stack: event.error && event.error.stack }));
  window.addEventListener('unhandledrejection', event => window.petOffice.reportRendererCrash({ kind: 'renderer-rejection', message: String(event.reason && (event.reason.stack || event.reason.message) || event.reason) }));
  bindFileDrop();
}

function clearDropTargets() {
  for (const pet of pets.values()) pet.el.classList.remove('drop-target');
}

function dropTargetPet(event) {
  const element = event.target && event.target.closest ? event.target.closest('.pet') : null;
  if (element) return pets.get(element.id.replace(/^pet-/, '')) || null;
  const composer = event.target && event.target.closest ? event.target.closest('#composer') : null;
  if (composer && composerPetId) return pets.get(composerPetId) || null;
  return null;
}

function bindFileDrop() {
  document.addEventListener('dragover', event => {
    const types = event.dataTransfer && event.dataTransfer.types;
    const accepted = ['Files', 'text/uri-list', 'text/plain', 'text/html'];
    if (!types || !Array.from(types).some(type => accepted.includes(type))) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    window.petOffice.setMouseIgnore(false);
    const target = dropTargetPet(event);
    for (const pet of pets.values()) pet.el.classList.toggle('drop-target', !!target && pet.id === target.id);
  });
  document.addEventListener('dragleave', event => {
    if (event.relatedTarget) return;
    clearDropTargets();
  });
  document.addEventListener('drop', async event => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    // Prevent browser navigation synchronously; doing this after an IPC await is too late.
    event.preventDefault();
    clearDropTargets();
    const target = dropTargetPet(event) || pets.get('supervisor');
    if (!target) return;
    const files = Array.from(dataTransfer.files || []);
    const rawLinks = {
      uriList: dataTransfer.getData('text/uri-list') || '',
      plain: dataTransfer.getData('text/plain') || '',
      html: dataTransfer.getData('text/html') || '',
    };
    const links = await window.petOffice.normalizeLinks(rawLinks);
    if (!files.length && !links.length) return;
    if (files.length) {
      const paths = files.map(file => window.petOffice.pathForFile(file)).filter(Boolean);
      if (!paths.length) bubble(target.id, '未能读取拖入文件的路径，请重试', 7000);
      else {
        bubble(target.id, '正在接收 ' + paths.length + ' 个文件…', 4000);
        await receiveDroppedPaths(target.id, paths);
      }
    }
    if (links.length) await receiveDroppedLinks(target.id, links);
  });
}

function onChatEvent(event) {
  const pet = pets.get(event.petId);
  if (!pet) return;
  let task = tasks.find(item => item.id === event.taskId);
  if (event.type === 'started') {
    if (!task) {
      task = {
        id: event.taskId, petId: event.petId, brief: event.text || '', status: 'running',
        threadId: event.threadId || null, tokens: 0, kind: 'conversation', startedAt: Date.now(),
      };
      tasks.push(task);
    }
    chatStreams.set(event.taskId, '');
    setStatus(pet, 'working');
    bubble(pet.id, '正在思考…', 12000);
    updateLiveTaskCard();
    return;
  }
  if (event.type === 'progress') {
    task = event.task ? upsertTask(event.task) : task;
    if (task) {
      task.progress = event.text || task.progress || '';
      task.progressStage = event.stage || task.progressStage || 'working';
      task.updatedAt = Date.now();
    }
    setStatus(pet, 'working');
    updateLiveTaskCard();
    return;
  }
  if (event.type === 'delta') {
    const text = (chatStreams.get(event.taskId) || '') + String(event.delta || '');
    chatStreams.set(event.taskId, text);
    if (task) {
      task.progress = tail(text.replace(/\s+/g, ' ').trim(), 220) || '正在思考…';
      task.progressStage = 'report';
      task.updatedAt = Date.now();
    }
    bubble(pet.id, tail(text.replace(/\s+/g, ' ').trim(), 220) || '正在思考…', 12000, 'detail');
    updateLiveTaskCard();
    return;
  }
  if (event.type === 'usage') {
    if (task) task.tokens = event.tokens || 0;
    return;
  }
  if (event.type === 'needs-input') {
    if (task) task.status = 'waiting_input';
    setStatus(pet, 'needs_input');
    bubble(pet.id, '需要你的确认或回答', 15000, 'attention');
    updateActivityBadge();
    updateLiveTaskCard();
    return;
  }
  if (event.type === 'resumed') {
    if (task) task.status = 'running';
    setStatus(pet, 'working');
    bubble(pet.id, '收到，继续处理…', 5000);
    updateLiveTaskCard();
    return;
  }
  if (task) {
    task.status = event.type === 'done' ? 'done' : (event.type === 'cancelled' ? 'cancelled' : 'failed');
    task.threadId = event.threadId || task.threadId;
    task.tokens = event.tokens || task.tokens || 0;
  }
  chatStreams.delete(event.taskId);
  if (event.type === 'done') {
    setStatus(pet, 'done');
    bubble(pet.id, tail(String(event.text || '').replace(/\s+/g, ' ').trim(), 260) || '完成了 ✔', 15000, 'completion');
  } else if (event.type === 'cancelled') {
    setStatus(pet, 'cancelled');
    bubble(pet.id, '已取消', 5000, 'attention');
  } else if (event.type === 'failed') {
    setStatus(pet, 'failed');
    bubble(pet.id, '出错了：' + (event.error || '任务失败'), 9000, 'error');
  }
  updateLiveTaskCard(true);
  refreshState();
}

function syncPetTaskStatus() {
  const now = Date.now();
  const byFresh = (a, b) => (b.updatedAt || b.finishedAt || b.startedAt || 0) - (a.updatedAt || a.finishedAt || a.startedAt || 0);
  for (const pet of pets.values()) {
    const relevant = tasks.filter(task => task.petId === pet.id);
    for (const task of relevant) {
      const previous = previousTaskStatuses.get(task.id);
      previousTaskStatuses.set(task.id, task.status);
      if (!previous || previous === task.status) continue;
      if (task.source === 'desktop' && task.status === 'cancelled') bubble('supervisor', '任务已中断', 5000, 'attention');
      if (task.source === 'desktop' && task.status === 'failed') bubble('supervisor', '任务出错：' + short(task.error || task.progress, 80), 6000, 'error');
    }
    const current = relevant
      .filter(task => ['queued', 'running', 'waiting_input'].includes(task.status))
      .sort(byFresh)[0];
    const newest = current || relevant
      .filter(task => {
        if (!TERMINAL_PET_STATUSES.has(task.status)) return false;
        const at = task.updatedAt || task.finishedAt || task.startedAt || 0;
        return at > 0 && now - at <= TERMINAL_TASK_WINDOW_MS;
      })
      .sort(byFresh)[0] || null;
    if (!newest) {
      if (pet.status !== 'idle') setStatus(pet, 'idle');
      continue;
    }
    pet.brief = newest.brief || '';
    setStatus(pet, statusForTask(newest.status));
  }
}

function applyTaskSnapshot(payload) {
  const snapshot = Array.isArray(payload) ? payload : (payload && payload.tasks);
  if (!Array.isArray(snapshot)) return;
  tasks = snapshot;
  if (payload && !Array.isArray(payload) && payload.monitor) S.desktopMonitor = payload.monitor;
  syncPetTaskStatus();
  updateActivityBadge();
  updateLiveTaskCard();
  if (activitySurface.state !== 'closed') refreshActivityContents();
  refreshOpenPanelForLiveState();
}

function refreshOpenPanelForLiveState() {
  if (!openPanelFor) return;
  const tab = panelTabs.get(openPanelFor) || 'overview';
  if (!['overview', 'work'].includes(tab)) return;
  const panel = $('#panel');
  const focused = document.activeElement;
  if (focused && panel.contains(focused) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(focused.tagName)) return;
  const page = panel.querySelector('.panel-page');
  const scrollTop = page ? page.scrollTop : 0;
  openPanel(openPanelFor, tab);
  const nextPage = panel.querySelector('.panel-page');
  if (nextPage) nextPage.scrollTop = scrollTop;
}

async function refreshState() {
  const next = await window.petOffice.getState();
  S = next;
  S.ui = S.ui || { delegationOn: false, hiddenPets: [] };
  S.ui.hiddenPets = Array.isArray(S.ui.hiddenPets) ? S.ui.hiddenPets : [];
  S.ui.petPositions = S.ui.petPositions || {};
  tasks = S.tasks || [];
  missions = S.missions || [];
  interactions = S.interactions || [];
  delegationOn = !!S.ui.delegationOn;
  applyAppearanceSettings();

  for (const pet of pets.values()) {
    const source = pet.id === 'supervisor' ? S.pets.supervisor : S.pets.workers.find(worker => worker.id === pet.id);
    if (source) {
      pet.name = source.name;
      pet.model = source.model;
      if (pet.skin !== source.skin) {
        pet.skin = source.skin;
        applySkin(pet);
      }
      pet.el.querySelector('.tag').innerHTML = esc(source.name) + '<span class="dot"></span>';
    }
  }
  syncPetTaskStatus();
  updateActivityBadge();
  updateLiveTaskCard();
  if (openPanelFor) openPanel(openPanelFor);
  if (activitySurface.state !== 'closed') refreshActivityContents();
}

function onTaskEvent(event) {
  if (event.task) upsertTask(event.task);
  if (event.type === 'progress') {
    const task = tasks.find(item => item.id === event.taskId);
    if (task) {
      task.progress = event.text || '';
      task.progressStage = event.stage || 'working';
      task.updatedAt = Date.now();
    }
    const progressPet = pets.get(event.petId);
    if (progressPet && event.text) bubble(progressPet.id, short(event.text, 180), 7000, 'detail');
    updateLiveTaskCard();
    if (activitySurface.state !== 'closed') refreshActivityContents();
    if (openPanelFor === event.petId) openPanel(event.petId, panelTabs.get(event.petId));
    return;
  }
  refreshState();
  const pet = pets.get(event.petId);
  if (!pet) return;
  if (event.type === 'started') {
    if (pet.role === 'worker') summonWorkers([pet.id], false);
    setStatus(pet, 'working');
    bubble(pet.id, '开工！', 2500);
  } else if (event.type === 'done') {
    setStatus(pet, 'done');
    bubble(pet.id, '我的部分完成了 ✔', 4000, 'completion');
  } else if (event.type === 'failed') {
    setStatus(pet, 'failed');
    bubble(pet.id, '出错了：' + (event.error || ('exit ' + event.exitCode)), 6000, 'error');
  } else if (event.type === 'queued') {
    setStatus(pet, 'queued');
  }
  updateLiveTaskCard(event.type === 'done' || event.type === 'failed');
}

function upsertTask(snapshot) {
  if (!snapshot || !snapshot.id) return null;
  const index = tasks.findIndex(task => task.id === snapshot.id);
  if (index >= 0) {
    tasks[index] = { ...tasks[index], ...snapshot };
    return tasks[index];
  }
  const task = { ...snapshot };
  tasks.push(task);
  return task;
}

function activeTask() {
  return [...tasks]
    .filter(task => ['queued', 'running', 'waiting_input'].includes(task.status))
    .sort((a, b) => (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0))[0] || null;
}

function activeMission() {
  return [...missions]
    .filter(mission => ['planning', 'awaiting_confirmation', 'running', 'reviewing', 'needs_input', 'interrupted'].includes(mission.status))
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))[0] || null;
}

function pinnedLiveSelection() {
  const key = S.ui && S.ui.pinnedLiveTaskKey;
  if (!key) return null;
  if (key.startsWith('mission:')) {
    const mission = missions.find(item => item.id === key.slice(8));
    return mission ? { type: 'mission', value: mission, key } : null;
  }
  if (key.startsWith('task:')) {
    const task = tasks.find(item => item.id === key.slice(5));
    return task ? { type: 'task', value: task, key } : null;
  }
  return null;
}

async function setPinnedLiveTask(key) {
  const next = (S.ui && S.ui.pinnedLiveTaskKey) === key ? null : key;
  S.ui.pinnedLiveTaskKey = next;
  await window.petOffice.setUi({ pinnedLiveTaskKey: next });
  updateLiveTaskCard(true);
  if (activitySurface.state !== 'closed') refreshActivityContents();
}

function updateLiveTaskCard(showCompletion = false) {
  const card = $('#live-task');
  if (!card) return;
  const blockingOverlay = ['#composer', '#panel', '#ctxmenu'].some(selector => !$(selector).classList.contains('hidden'));
  if (activitySurface.state !== 'closed' || blockingOverlay) {
    hideLiveTaskCard();
    return;
  }
  clearTimeout(liveTaskHideTimer);
  const pinned = pinnedLiveSelection();
  const latestMission = !pinned ? activeMission() : null;
  const latestTask = !pinned ? activeTask() : null;
  const missionAt = latestMission ? (latestMission.updatedAt || latestMission.createdAt || 0) : 0;
  const taskAt = latestTask ? (latestTask.updatedAt || latestTask.startedAt || 0) : 0;
  const mission = pinned && pinned.type === 'mission'
    ? pinned.value
    : (!pinned && latestMission && (!latestTask || missionAt >= taskAt) ? latestMission : null);
  if (mission) {
    const activeNodes = (mission.tasks || []).filter(task => ['ready', 'queued', 'running', 'succeeded', 'reviewing', 'retrying'].includes(task.status));
    const current = activeNodes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
    const status = mission.status === 'completed' ? 'done'
      : (mission.status === 'failed' ? 'failed'
        : (mission.status === 'cancelled' ? 'cancelled'
          : (['needs_input', 'interrupted', 'awaiting_confirmation', 'partially_succeeded'].includes(mission.status) ? 'needs_input' : 'working')));
    const detail = current ? ((current.assigneeName || current.assigneePetId) + ' · ' + missionTaskStatusLabel(current.status) + (current.progress ? ' · ' + short(current.progress, 70) : '')) : (MISSION_STATUS_TEXT[mission.status] || mission.status);
    const key = 'mission:' + mission.id;
    const pinnedMark = S.ui.pinnedLiveTaskKey === key;
    card.innerHTML = '<span class="live-task-dot ' + status + '"></span><span class="live-task-copy"><span class="live-task-meta"><strong>主管 Mission</strong><span class="live-task-source">' + esc(mission.projectName || '项目') + '</span><i>' + esc(MISSION_STATUS_TEXT[mission.status] || mission.status) + '</i>' + (activeNodes.length > 1 ? '<em>另有 ' + (activeNodes.length - 1) + ' 个节点</em>' : '') + '</span><b>' + esc(short(mission.objective, 72)) + '</b><small><i>阶段 ' + ((mission.currentWave || 0) + 1) + '</i>' + esc(detail) + '</small></span><span class="live-task-actions"><span class="live-pin' + (pinnedMark ? ' active' : '') + '" data-live-pin="' + esc(key) + '" title="' + (pinnedMark ? '取消固定' : '固定任务卡') + '">⌖</span><span class="live-task-open">›</span></span>';
    card.dataset.threadId = mission.supervisorThreadId || '';
    card.dataset.liveKey = key;
    card.classList.remove('hidden');
    const boss = pets.get('supervisor');
    if (boss) boss.el.classList.add('has-live-task');
    positionLiveTaskCard();
    return;
  }
  let task = pinned && pinned.type === 'task' ? pinned.value : (!pinned ? latestTask : null);
  if (!task && showCompletion) {
    task = [...tasks].filter(item => ['done', 'failed', 'cancelled'].includes(item.status)).slice(-1)[0] || null;
  }
  if (!task) {
    hideLiveTaskCard();
    return;
  }
  const status = statusForTask(task.status);
  const running = [...tasks].filter(item => ['queued', 'running', 'waiting_input'].includes(item.status));
  const pet = pets.get(task.petId);
  const agentName = task.petName || (pet && pet.name) || task.petId || 'Agent';
  const statusLabel = STATUS_TEXT[status] || '工作中';
  const title = short(task.brief || '正在处理任务', 72);
  const detail = short(task.progress || (status === 'working' ? '正在分析并处理…' : STATUS_TEXT[status]), 100);
  const source = task.source === 'desktop' ? (task.surface || 'Codex 桌面端') : (task.source === 'mission' ? 'Mission Agent' : (task.source === 'delegation' ? '分工 Agent' : '桌宠会话'));
  const model = modelName(task.model);
  const key = 'task:' + task.id;
  const pinnedMark = S.ui.pinnedLiveTaskKey === key;
  card.innerHTML = '<span class="live-task-dot ' + status + '"></span><span class="live-task-copy"><span class="live-task-meta"><strong>' + esc(agentName) + '</strong><span class="live-task-source">' + esc(source) + '</span><span class="live-task-model">' + esc(model) + '</span><i>' + esc(statusLabel) + '</i>' + (running.length > 1 ? '<em>另有 ' + (running.length - 1) + ' 项</em>' : '') + '</span><b>' + esc(title) + '</b><small><i>' + esc(progressStageLabel(task.progressStage)) + '</i>' + esc(detail) + '</small></span><span class="live-task-actions"><span class="live-pin' + (pinnedMark ? ' active' : '') + '" data-live-pin="' + esc(key) + '" title="' + (pinnedMark ? '取消固定' : '固定任务卡') + '">⌖</span><span class="live-task-open">›</span></span>';
  card.dataset.threadId = task.threadId || '';
  card.dataset.liveKey = key;
  card.classList.remove('hidden');
  const boss = pets.get('supervisor');
  if (boss) boss.el.classList.add('has-live-task');
  positionLiveTaskCard();
  if (!activeTask() && !pinnedMark) liveTaskHideTimer = setTimeout(hideLiveTaskCard, 6500);
}

function hideLiveTaskCard() {
  const card = $('#live-task');
  if (card) {
    card.classList.add('hidden');
    card.removeAttribute('data-thread-id');
    card.removeAttribute('data-live-key');
  }
  const boss = pets.get('supervisor');
  if (boss) boss.el.classList.remove('has-live-task');
}

function positionLiveTaskCard() {
  const card = $('#live-task');
  const boss = pets.get('supervisor');
  if (!card || card.classList.contains('hidden') || !boss) return;
  const rect = boss.el.getBoundingClientRect();
  const width = Math.min(410, innerWidth - 24);
  const left = Math.max(12, Math.min(innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  const preferredTop = rect.bottom + 43;
  card.style.width = width + 'px';
  card.style.left = Math.round(left) + 'px';
  card.style.top = Math.round(Math.min(innerHeight - card.offsetHeight - 12, preferredTop)) + 'px';
}

function setStatus(pet, status) {
  pet.status = status;
  if (status === 'idle') delete pet.el.dataset.status;
  else pet.el.dataset.status = status;
  clearTimeout(pet.statusTimer);
  if (status === 'done') {
    pet.celebrateUntil = Date.now() + CELEBRATE_MS;
    clearTimeout(pet.celebrateTimer);
    pet.celebrateTimer = setTimeout(() => {
      pet.celebrateUntil = 0;
      updateSkinState(pet);
    }, CELEBRATE_MS + 40);
  }
  if (TERMINAL_PET_STATUSES.has(status)) {
    // 终态徽章只短暂展示，避免绿色对勾等标记永久挂在桌宠身上。
    pet.statusTimer = setTimeout(() => {
      pet.statusTimer = null;
      setStatus(pet, 'idle');
    }, STATUS_BADGE_MS);
  }
  updateSkinState(pet);
}

function applySkin(pet) {
  if (!pet || !pet.el) return;
  const skin = skinRecord(pet.skin);
  const sprite = pet.el.querySelector('.skin-sprite');
  if (!skin) {
    pet.el.classList.remove('petdex-skin');
    sprite.style.backgroundImage = '';
    stopSpriteAnimation(pet);
    return;
  }
  pet.el.classList.add('petdex-skin');
  sprite.style.backgroundImage = 'url("' + skin.assetUrl.replace(/"/g, '%22') + '")';
  sprite.style.backgroundSize = (skin.columns || 8) * 100 + '% ' + (skin.rows || 9) * 100 + '%';
  startSpriteAnimation(pet);
}

const SKIN_ROWS = { idle: 0, runRight: 1, runLeft: 2, wave: 3, jump: 4, failed: 5, waiting: 6, working: 7, review: 8 };
const FRAME_MS = 130;
const CELEBRATE_MS = 2600;
const skinGrids = new Map();

function skinRowFor(pet) {
  if (pet.hoverRow != null) return pet.hoverRow;
  if (pet.walkRow != null) return pet.walkRow;
  if (pet.celebrateUntil && pet.celebrateUntil > Date.now()) return SKIN_ROWS.jump;
  if (pet.status === 'working') return SKIN_ROWS.working;
  if (pet.status === 'needs_input') return SKIN_ROWS.wave;
  if (pet.status === 'queued') return SKIN_ROWS.waiting;
  if (pet.status === 'failed' || pet.status === 'capped') return SKIN_ROWS.failed;
  if (pet.status === 'done') return SKIN_ROWS.review;
  return SKIN_ROWS.idle;
}

function setSkinPose(pet, key, value) {
  if (!pet || pet[key] === value) return;
  pet[key] = value;
  updateSkinState(pet);
}

function stopSpriteAnimation(pet) {
  if (pet && pet.spriteAnim) {
    try { pet.spriteAnim.cancel(); } catch {}
    pet.spriteAnim = null;
  }
}

function startSpriteAnimation(pet) {
  if (!pet || !pet.el || !pet.el.classList.contains('petdex-skin')) return;
  const skin = skinRecord(pet.skin);
  if (!skin) return;
  const token = (pet.spriteToken = (pet.spriteToken || 0) + 1);
  ensureSkinGrid(skin).then(grid => {
    if (token !== pet.spriteToken) return;
    paintSprite(pet, skin, grid);
  });
}

function ensureSkinGrid(skin) {
  if (skinGrids.has(skin.slug)) return Promise.resolve(skinGrids.get(skin.slug));
  const fallback = { columns: Math.max(1, skin.columns || 8), rows: Math.max(1, skin.rows || 9), frameCounts: null };
  skinGrids.set(skin.slug, fallback);
  return window.petOffice.skinData(skin.slug).then(dataUrl => {
    if (!dataUrl) return fallback;
    return loadImageElement(dataUrl).then(image => {
      const frameWidth = Math.max(1, skin.frameWidth || 192);
      const frameHeight = Math.max(1, skin.frameHeight || 208);
      let columns = Math.round(image.naturalWidth / frameWidth);
      let rows = Math.round(image.naturalHeight / frameHeight);
      if (!columns || Math.abs(image.naturalWidth / frameWidth - columns) > 0.1) columns = fallback.columns;
      if (!rows || Math.abs(image.naturalHeight / frameHeight - rows) > 0.1) rows = fallback.rows;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const grid = {
        columns,
        rows,
        frameCounts: countFilledFrames(context, image.naturalWidth / columns, image.naturalHeight / rows, columns, rows),
      };
      skinGrids.set(skin.slug, grid);
      return grid;
    });
  }).catch(() => fallback);
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('skin image decode failed'));
    image.src = url;
  });
}

function countFilledFrames(context, frameWidth, frameHeight, columns, rows) {
  const counts = [];
  for (let row = 0; row < rows; row++) {
    let filled = 0;
    for (let column = 0; column < columns; column++) {
      const x = Math.round(column * frameWidth);
      const y = Math.round(row * frameHeight);
      const width = Math.max(1, Math.round(frameWidth));
      const height = Math.max(1, Math.round(frameHeight));
      let occupied = false;
      try {
        const data = context.getImageData(x, y, width, height).data;
        for (let index = 3; index < data.length; index += 4 * 31) {
          if (data[index] > 24) { occupied = true; break; }
        }
      } catch { occupied = true; }
      if (occupied) filled = column + 1;
    }
    counts.push(filled);
  }
  return counts;
}

function paintSprite(pet, skin, grid) {
  const sprite = pet.el.querySelector('.skin-sprite');
  if (!sprite) return;
  const columns = Math.max(1, grid.columns);
  const rows = Math.max(1, grid.rows);
  const row = Math.max(0, Math.min(rows - 1, skinRowFor(pet)));
  const declared = (grid.frameCounts && grid.frameCounts[row]) || columns;
  const frames = Math.max(1, Math.min(columns, declared));
  const offset = value => (columns > 1 ? (value / (columns - 1)) * 100 : 0) + '%';

  stopSpriteAnimation(pet);
  sprite.style.backgroundSize = columns * 100 + '% ' + rows * 100 + '%';
  sprite.style.backgroundPositionY = (rows > 1 ? (row / (rows - 1)) * 100 : 0) + '%';
  sprite.style.backgroundPositionX = offset(0);
  if (frames < 2 || motionReduced()) return;

  const keyframes = [];
  for (let index = 0; index < frames; index++) {
    keyframes.push({ backgroundPositionX: offset(index), offset: index / frames, easing: 'steps(1, end)' });
  }
  keyframes.push({ backgroundPositionX: offset(0), offset: 1 });
  pet.spriteAnim = sprite.animate(keyframes, { duration: frames * FRAME_MS, iterations: Infinity });
}

function updateSkinState(pet) {
  if (!pet || !pet.el || !pet.el.classList.contains('petdex-skin')) return;
  startSpriteAnimation(pet);
}

function bubbleAllowed(kind) {
  const mode = (S.settings || {}).notificationMode || 'standard';
  if (mode === 'quiet') return ['attention', 'error'].includes(kind);
  if (mode === 'standard') return kind !== 'detail';
  return true;
}

function bubble(petId, text, timeout = 5000, kind = 'standard') {
  if (!bubbleAllowed(kind)) return;
  const pet = pets.get(petId);
  if (!pet) return;
  const element = pet.el.querySelector('.bubble');
  element.textContent = text;
  element.classList.remove('hidden');
  announce(pet.name + '：' + text);
  clearTimeout(bubbleTimers[petId]);
  bubbleTimers[petId] = setTimeout(() => element.classList.add('hidden'), timeout);
}

function summonWorkers(ids, persist = true) {
  const unique = [...new Set((ids || []).filter(id => id !== 'supervisor' && pets.has(id)))];
  unique.forEach((id, index) => {
    const pet = pets.get(id);
    const home = petHome(id);
    if (pet.el.classList.contains('hidden-pet')) {
      pet.el.classList.remove('hidden-pet');
      if (motionReduced()) {
        pet.el.style.left = home.x + 'px';
        pet.el.style.top = home.y + 'px';
        pet.el.classList.remove('walking');
        setSkinPose(pet, 'walkRow', null);
        if (!persist) temporarySummons.add(id);
        return;
      }
      pet.el.style.left = (innerWidth + 70) + 'px';
      pet.el.style.top = home.y + 'px';
      setTimeout(() => {
        pet.el.classList.add('walking');
        walkTo(pet, home.x, home.y);
      }, 100 + index * 180);
    }
    if (!persist) temporarySummons.add(id);
  });
  if (persist && unique.length) {
    S.ui.hiddenPets = S.ui.hiddenPets.filter(id => !unique.includes(id));
    window.petOffice.setUi({ hiddenPets: S.ui.hiddenPets });
  }
}

function hideWorker(id, persist = true) {
  const pet = pets.get(id);
  if (!pet || pet.role !== 'worker') return;
  if (motionReduced()) {
    pet.el.classList.add('hidden-pet');
    pet.el.classList.remove('walking');
    setSkinPose(pet, 'walkRow', null);
    temporarySummons.delete(id);
    if (persist && !S.ui.hiddenPets.includes(id)) {
      S.ui.hiddenPets.push(id);
      window.petOffice.setUi({ hiddenPets: S.ui.hiddenPets });
    }
    return;
  }
  pet.el.classList.add('walking');
  walkTo(pet, innerWidth + 90, petHome(id).y);
  setTimeout(() => {
    pet.el.classList.add('hidden-pet');
    pet.el.classList.remove('walking');
  }, 1150);
  temporarySummons.delete(id);
  if (persist && !S.ui.hiddenPets.includes(id)) {
    S.ui.hiddenPets.push(id);
    window.petOffice.setUi({ hiddenPets: S.ui.hiddenPets });
  }
}

function restoreWorkerVisibility() {
  for (const id of [...temporarySummons]) {
    const active = tasks.some(task => task.petId === id && ['queued', 'running', 'waiting_input'].includes(task.status));
    if (!active && S.ui.hiddenPets.includes(id)) hideWorker(id, false);
  }
}

function walkTo(pet, x, y) {
  const from = parseFloat(pet.el.style.left) || 0;
  setSkinPose(pet, 'walkRow', x >= from ? SKIN_ROWS.runRight : SKIN_ROWS.runLeft);
  pet.el.style.left = x + 'px';
  pet.el.style.top = y + 'px';
  setTimeout(() => {
    pet.el.classList.remove('walking');
    setSkinPose(pet, 'walkRow', null);
  }, 1200);
}

function showTooltip(petId) {
  const pet = pets.get(petId);
  if (!pet) return;
  const current = tasks.find(task => task.petId === petId && ['queued', 'running', 'waiting_input'].includes(task.status));
  const tooltip = $('#tooltip');
  tooltip.innerHTML = '<b>' + esc(pet.name) + '</b><span class="tooltip-model">' + esc(modelName(pet.model)) + '</span>' +
    '<div>' + esc(STATUS_TEXT[pet.status] || '待命') + (current ? ' · ' + esc(short(current.progress || current.brief, 52)) : '') + '</div>';
  tooltip.classList.remove('hidden');
  const rect = pet.el.getBoundingClientRect();
  tooltip.style.left = Math.max(8, Math.min(rect.left - 30, innerWidth - 350)) + 'px';
  tooltip.style.top = Math.max(8, rect.top - tooltip.offsetHeight - 12) + 'px';
}

function hideTooltip() {
  $('#tooltip').classList.add('hidden');
}

function closeOverlays() {
  $('#panel').classList.add('hidden');
  closeActivity(true);
  $('#ctxmenu').classList.add('hidden');
  closeComposer();
  openPanelFor = null;
  updateLiveTaskCard();
  if ($('#composer').classList.contains('hidden')) syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y));
}

function closeComposer(immediate = false) {
  const composer = $('#composer');
  if (composer.classList.contains('hidden')) return;
  composerSurface.epoch++;
  cancelComposerMotion();
  const pet = composerPetId && pets.get(composerPetId);
  composerPetId = null;
  const wasPetComposer = composer.classList.contains('pet-composer');
  clearTimeout(composerCloseTimer);
  composer.getAnimations().forEach(animation => animation.cancel());
  if (immediate || motionReduced() || !pet || !wasPetComposer) {
    finishComposerClose();
    return;
  }
  composer.classList.remove('ready');
  const button = quickButtonRect(pet);
  const current = composerBox();
  const shrink = composer.animate([
    { left: current.left + 'px', top: current.top + 'px', width: current.width + 'px', height: current.height + 'px', borderRadius: '18px' },
    { left: button.left + 'px', top: button.top + 'px', width: button.width + 'px', height: button.height + 'px', borderRadius: '9999px' },
  ], { duration: 190, easing: 'cubic-bezier(.4,0,.68,.16)', fill: 'forwards' });
  shrink.onfinish = finishComposerClose;
  composerCloseTimer = setTimeout(finishComposerClose, 420);
}

function finishComposerClose() {
  const composer = $('#composer');
  composerSurface.epoch++;
  cancelComposerMotion();
  clearTimeout(composerCloseTimer);
  composer.getAnimations().forEach(animation => animation.cancel());
  composer.classList.add('hidden');
  composer.classList.remove('morphing', 'ready', 'collapsing');
  composer.removeAttribute('style');
  petMapValues().forEach(pet => pet.el.classList.remove('composer-open'));
  composerAttachments = [];
  updateLiveTaskCard();
  syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y));
}

function petMapValues() {
  return [...pets.values()];
}

function modelOptions(selected) {
  return '<option value=""' + (!selected ? ' selected' : '') + '>Codex 默认</option>' +
    (S.models || []).map(model => {
      const tags = capabilityLabels(model.slug).slice(0, 3);
      return '<option value="' + esc(model.slug) + '"' + (model.slug === selected ? ' selected' : '') + '>' + esc(model.name + (tags.length ? ' · ' + tags.join('/') : '')) + '</option>';
    }).join('');
}

function resetText(report) {
  const format = seconds => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return [
    report.fiveHourResetAt ? '5h 恢复 ' + format(report.fiveHourResetAt) : null,
    report.weeklyResetAt ? '周重置 ' + format(report.weeklyResetAt) : null,
  ].filter(Boolean).join(' · ');
}

function quotaBlock(slug) {
  const provider = providerOf(slug);
  const label = providerLabel(provider);
  const quota = S.quotas || {};
  const report = (quota.reports || []).find(item => item.provider === provider);
  const stale = !!quota.stale;
  const staleNote = stale
    ? '<div class="quota-stale">缓存数据 · ' + esc(quota.error || '刷新失败') + '</div>'
    : '';
  if (!quota.ok && !report) {
    return '<section class="quota-card warning"><div class="quota-title">' + esc(label) + ' 额度</div><div>暂时无法读取额度，请确认 OpenCodex 代理正在运行。</div></section>';
  }
  if (!report) {
    return '<section class="quota-card"><div class="quota-title">' + esc(label) + ' 额度</div><div class="quota-empty">该供应商没有公开可用的额度接口</div></section>';
  }
  const scope = provider === 'openai' ? '账户级额度 · 所有 GPT Agent 共享' : 'API 账户额度 · 同供应商 Agent 共享';
  if (report.kind === 'codex') {
    const fiveHour = Math.max(0, 100 - (report.fiveHourUsed || 0));
    const weekly = report.weeklyUsed == null ? null : Math.max(0, 100 - report.weeklyUsed);
    return '<section class="quota-card">' +
      '<div class="quota-title"><span>' + esc(label) + '</span><button class="icon-btn" id="quota-refresh" title="刷新额度">↻</button></div>' +
      '<div class="quota-scope">' + esc(scope) + '</div>' +
      quotaLine('5 小时', fiveHour) + (weekly == null ? '' : quotaLine('本周', weekly)) +
      '<div class="quota-time">' + esc(resetText(report)) + '</div>' + staleNote + '</section>';
  }
  if (report.kind === 'balance') {
    return '<section class="quota-card"><div class="quota-title"><span>' + esc(label) + '</span><button class="icon-btn" id="quota-refresh" title="刷新额度">↻</button></div>' +
      '<div class="quota-scope">' + esc(scope) + '</div><div class="balance-text">' + esc(report.balanceText) + '</div>' + staleNote + '</section>';
  }
  return '<section class="quota-card"><div class="quota-title">' + esc(label) + ' 额度</div><div class="quota-empty">供应商返回了额度信息，但格式暂不支持</div></section>';
}

function quotaLine(label, percentage) {
  return '<div class="quota-line"><span>' + esc(label) + '</span><div class="meter"><i style="width:' + percentage + '%"></i></div><b>' + percentage + '%</b></div>';
}

function recentTasksFor(petId, limit = 6) {
  const source = petId ? tasks.filter(task => task.petId === petId) : tasks;
  if (!source.length) return '<div class="empty-state">还没有任务记录</div>';
  return '<div class="task-list">' + source.slice(-limit).reverse().map(task => {
    const actions = (task.threadId ? '<button class="text-btn" data-thread-task="' + esc(task.id) + '">打开会话</button>' : '') +
      (task.resultPath ? '<button class="text-btn" data-result-task="' + esc(task.id) + '">查看结果</button>' : '');
    return '<article class="task-item"><div class="task-meta"><span class="status-dot ' + statusForTask(task.status) + '"></span>' +
      '<b>' + esc(task.petName || '') + '</b><span>' + esc(STATUS_TEXT[statusForTask(task.status)] || task.status) + '</span></div>' +
      '<div class="task-copy">' + esc(short(task.brief, 62)) + '</div>' + (task.progress ? '<div class="task-live"><span>动态</span>' + esc(short(task.progress, 96)) + '</div>' : '') + '<div class="task-actions">' + actions + '</div></article>';
  }).join('') + '</div>';
}

function currentProject() {
  return (S.projects || []).find(project => project.id === S.activeProjectId && !project.archived) || null;
}

function projectOptions() {
  const active = (S.projects || []).filter(project => !project.archived);
  if (!active.length) return '<option value="">尚无可用项目</option>';
  return active.map(project => '<option value="' + esc(project.id) + '"' + (project.id === S.activeProjectId ? ' selected' : '') + '>' + esc(project.name) + '</option>').join('');
}

function projectManagementHtml(project) {
  const archived = (S.projects || []).filter(item => item.archived);
  const archivedHtml = archived.length ? '<details class="archived-projects" open><summary>已归档项目 · ' + archived.length + '</summary>' + archived.map(item => '<div><span><b>' + esc(item.name) + '</b><small>' + esc(item.path) + '</small></span><button class="btn compact" data-restore-project="' + esc(item.id) + '">恢复</button></div>').join('') + '</details>' : '';
  if (!project) return '<div class="empty-state project-empty">新建、添加或恢复项目后，可在这里管理会话与附件。</div>' + archivedHtml;
  const sessions = projectSessionCache.get(project.id) || [];
  const sessionCount = projectSessionCache.has(project.id) ? sessions.length : (project.threadIds || []).length;
  const sessionRows = sessions.length ? sessions.slice(0, 12).map(session =>
    '<div class="session-row"><span class="status-dot ' + statusForTask(session.status) + '"></span><div><b>' + esc(short(session.title, 58)) + '</b><small>' + esc(session.petName) + ' · ' + esc(modelName(session.model)) + (session.current ? ' · 当前上下文' : '') + '</small></div><button class="text-btn" data-project-thread="' + esc(session.threadId) + '">打开</button></div>'
  ).join('') : '<div class="empty-state">暂无项目会话；发送第一条消息后会出现在这里。</div>';
  return '<section class="project-manager"><div class="section-title">项目管理</div>' +
    '<div class="project-summary"><div><b>' + esc(project.name) + '</b><small>' + esc(project.path) + '</small></div><span>' + sessionCount + ' 个会话</span></div>' +
    '<div class="project-primary-actions"><button class="btn" id="p-rename-project">重命名项目</button><button class="btn" id="p-new-session">新建空白会话</button></div>' +
    '<div class="section-title">会话</div><div class="session-list">' + sessionRows + '</div>' +
    '<details class="project-tools"><summary>项目操作</summary><div class="project-tools-grid"><button class="btn" id="p-archive-project">归档项目</button><button class="btn" id="p-clear-attachments">清理附件</button><button class="btn danger" id="p-reset-context">重置主管上下文</button><button class="btn danger" id="p-remove-project">移除列表</button></div><small>这些操作会改变项目状态或上下文，执行前会再次确认。</small></details>' +
    archivedHtml + '</section>';
}

function taskProjectId(task) {
  if (task.projectId) return task.projectId;
  const cwd = String(task.cwd || '').replace(/\\/g, '/').toLowerCase();
  if (!cwd) return null;
  const project = (S.projects || []).find(item => {
    const root = String(item.path || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    return cwd === root || cwd.startsWith(root + '/');
  });
  return project ? project.id : null;
}

function matchesProjectFilter(item) {
  const filter = (S.ui && S.ui.taskProjectFilter) || 'all';
  if (filter === 'all') return true;
  return (item.projectId || taskProjectId(item)) === filter;
}

function projectFilterOptions() {
  const filter = (S.ui && S.ui.taskProjectFilter) || 'all';
  return '<option value="all"' + (filter === 'all' ? ' selected' : '') + '>全部项目</option>' +
    (S.projects || []).map(project => '<option value="' + esc(project.id) + '"' + (project.id === filter ? ' selected' : '') + '>' + esc(project.name) + (project.archived ? '（已归档）' : '') + '</option>').join('');
}

function activityPriority(status) {
  return ({ waiting_input: 0, running: 1, queued: 1, failed: 2, capped: 2, unknown: 2, done: 3, cancelled: 4 })[status] ?? 5;
}

function updateActivityBadge() {
  const button = document.querySelector('[data-activity]');
  if (!button) return;
  const badge = button.querySelector('.activity-badge');
  const interactionThreads = new Set(interactions.map(item => item.threadId).filter(Boolean));
  const extraWaiting = tasks.filter(task => task.status === 'waiting_input' && (!task.threadId || !interactionThreads.has(task.threadId))).length;
  const missionAttention = missions.filter(mission => ['awaiting_confirmation', 'needs_input', 'interrupted'].includes(mission.status)).length;
  const count = interactions.length + extraWaiting + missionAttention;
  badge.textContent = count > 9 ? '9+' : String(count);
  badge.classList.toggle('hidden', count === 0);
  button.classList.toggle('attention', count > 0);
}

function interactionCardHtml(item) {
  if (item.kind === 'question') {
    const fields = (item.questions || []).map(question => {
      const options = Array.isArray(question.options) ? question.options : [];
      const control = options.length && !question.isOther
        ? '<select data-answer="' + esc(question.id) + '">' + options.map(option => '<option value="' + esc(option.label) + '">' + esc(option.label) + '</option>').join('') + '</select>'
        : '<input data-answer="' + esc(question.id) + '" type="' + (question.isSecret ? 'password' : 'text') + '" placeholder="输入回答">';
      return '<label class="interaction-question"><b>' + esc(question.header || '问题') + '</b><span>' + esc(question.question || '') + '</span>' + control + '</label>';
    }).join('');
    return '<article class="interaction-card urgent" data-interaction-card="' + esc(item.id) + '"><div class="interaction-title"><span>需要回答</span><b>' + esc(item.title) + '</b></div>' + fields +
      '<div class="interaction-actions"><button class="btn primary" data-answer-submit="' + esc(item.id) + '">提交回答</button>' +
      (item.threadId ? '<button class="btn" data-activity-thread="' + esc(item.threadId) + '">在 Codex 中查看</button>' : '') + '</div></article>';
  }
  return '<article class="interaction-card urgent" data-interaction-card="' + esc(item.id) + '"><div class="interaction-title"><span>需要批准</span><b>' + esc(item.title) + '</b></div>' +
    '<p>' + esc(item.reason || '') + '</p>' + (item.detail ? '<pre>' + esc(short(item.detail, 520)) + '</pre>' : '') +
    '<div class="interaction-actions"><button class="btn primary" data-interaction-approve="' + esc(item.id) + '">允许一次</button><button class="btn danger" data-interaction-deny="' + esc(item.id) + '">拒绝</button>' +
    (item.threadId ? '<button class="btn" data-activity-thread="' + esc(item.threadId) + '">在 Codex 中查看</button>' : '') + '</div></article>';
}

function activityTaskHtml(task) {
  const status = statusForTask(task.status);
  const label = STATUS_TEXT[status] || task.status || '待命';
  const source = task.source === 'desktop' ? (task.surface || 'Codex 桌面端') : (task.source === 'mission' ? 'Mission' : (task.source === 'delegation' ? '分工' : '桌宠会话'));
  return '<article class="activity-task" data-task-status="' + esc(task.status) + '"><span class="status-dot ' + status + '"></span><div class="activity-task-copy"><div><b>' + esc(task.petName || (pets.get(task.petId) && pets.get(task.petId).name) || task.petId || 'Agent') + '</b><small class="task-source">' + esc(source) + '</small><small>' + esc(modelName(task.model)) + '</small></div><p>' + esc(short(task.brief, 110)) + '</p>' + (task.progress ? '<p class="activity-progress"><span>' + esc(progressStageLabel(task.progressStage)) + '</span>' + esc(short(task.progress, 150)) + '</p>' : '') + '</div>' +
    '<div class="activity-task-side"><span>' + esc(label) + '</span><button class="text-btn pin-task' + (S.ui.pinnedLiveTaskKey === 'task:' + task.id ? ' active' : '') + '" data-pin-task="task:' + esc(task.id) + '">' + (S.ui.pinnedLiveTaskKey === 'task:' + task.id ? '已固定' : '固定') + '</button>' + (task.threadId ? '<button class="text-btn" data-activity-thread="' + esc(task.threadId) + '">打开</button>' : '') + '</div></article>';
}

function missionStatusClass(status) {
  if (status === 'completed') return 'done';
  if (status === 'partially_succeeded') return 'partial';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (['needs_input', 'interrupted', 'awaiting_confirmation'].includes(status)) return 'attention';
  return 'working';
}

function missionTaskStatusLabel(status) {
  return ({ blocked: '等待依赖', ready: '可执行', queued: '排队', running: '工作中', succeeded: '等待检查', reviewing: '检查中', retrying: '准备重试', accepted: '已接受', failed: '失败', skipped: '跳过', cancelled: '取消', interrupted: '中断' })[status] || status;
}

function missionCardHtml(mission) {
  const waves = new Map();
  for (const task of mission.tasks || []) {
    const wave = Number(task.wave) || 0;
    if (!waves.has(wave)) waves.set(wave, []);
    waves.get(wave).push(task);
  }
  const taskRows = [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, items]) =>
    '<div class="mission-wave"><div class="mission-wave-title">阶段 ' + (wave + 1) + '<span>' + items.length + '</span></div>' + items.map(task =>
      '<div class="mission-node"><span class="mission-node-state ' + esc(task.status) + '"></span><div><b>' + esc(task.title) + '</b><small>' + esc(task.assigneeName || task.assigneePetId) + ' · ' + esc(modelName(task.model)) + (task.dependsOn.length ? ' · 依赖 ' + esc(task.dependsOn.join(', ')) : '') + '</small>' + (task.review && task.review.reason ? '<p>' + esc(short(task.review.reason, 130)) + '</p>' : '') + '</div><aside><span>' + esc(missionTaskStatusLabel(task.status)) + '</span>' + (task.attempts ? '<i>第 ' + task.attempts + ' 次</i>' : '') + (task.threadId ? '<button class="text-btn" data-activity-thread="' + esc(task.threadId) + '">打开</button>' : '') + '</aside></div>'
    ).join('') + '</div>'
  ).join('');
  let actions = '';
  if (mission.status === 'awaiting_confirmation') actions = '<button class="btn" data-mission-regenerate="' + esc(mission.id) + '">重新规划</button><button class="btn primary" data-mission-confirm="' + esc(mission.id) + '">确认执行</button>';
  else if (mission.status === 'interrupted') actions = '<button class="btn primary" data-mission-resume="' + esc(mission.id) + '">检查并恢复</button>';
  else if (mission.status === 'needs_input' && mission.pendingAction && mission.pendingAction.kind === 'high_risk') actions = '<button class="btn danger" data-mission-apply="' + esc(mission.id) + '">确认高风险回写</button>';
  else if (mission.status === 'needs_input' && mission.pendingAction) actions = '<button class="btn" data-mission-resolved="' + esc(mission.id) + '">我已手动处理</button>';
  if (['planning', 'awaiting_confirmation', 'running', 'reviewing', 'needs_input', 'interrupted'].includes(mission.status)) actions += '<button class="btn danger subtle" data-mission-cancel="' + esc(mission.id) + '">取消 Mission</button>';
  const key = 'mission:' + mission.id;
  return '<details class="mission-card" data-mission-id="' + esc(mission.id) + '" data-mission-status="' + esc(mission.status) + '"' + (['running', 'reviewing', 'needs_input'].includes(mission.status) ? ' open' : '') + '><summary><span class="mission-status ' + missionStatusClass(mission.status) + '"></span><div><b>' + esc(short(mission.objective, 120)) + '</b><small>' + esc(mission.projectName || '') + ' · ' + esc(MISSION_STATUS_TEXT[mission.status] || mission.status) + ' · 当前阶段 ' + ((mission.currentWave || 0) + 1) + '</small></div><i>›</i></summary><div class="mission-body">' + (mission.error ? '<div class="mission-warning">' + esc(mission.error) + '</div>' : '') + (mission.pendingAction ? '<div class="mission-warning">等待处理：' + esc(mission.pendingAction.kind) + '</div>' : '') + taskRows + (mission.finalReview ? '<div class="mission-final"><b>主管最终复核</b><p>' + esc(mission.finalReview.summary || '') + '</p></div>' : '') + '<div class="mission-actions"><button class="btn" data-pin-task="' + esc(key) + '">' + (S.ui.pinnedLiveTaskKey === key ? '取消固定' : '固定任务卡') + '</button>' + (mission.supervisorThreadId ? '<button class="btn" data-activity-thread="' + esc(mission.supervisorThreadId) + '">打开主管任务</button>' : '') + actions + '</div></div></details>';
}

function missionSectionHtml(items = missions) {
  if (!items.length) return '';
  return '<section class="mission-list"><div class="section-title">Mission<span>' + items.length + '</span></div>' + items.slice(0, 12).map(missionCardHtml).join('') + '</section>';
}

function progressStageLabel(stage) {
  return ({ thinking: '分析', command: '命令', file: '文件', tool: '工具', report: '回复', finishing: '汇总', waiting: '等待', warning: '提示' })[stage] || '动态';
}

function activitySectionHtml(title, items, collapsed = false) {
  if (!items.length) return '';
  const content = items.map(activityTaskHtml).join('');
  if (collapsed) return '<details class="activity-list activity-archive"><summary><span>' + esc(title) + '</span><i>' + items.length + '</i><b>⌄</b></summary><div>' + content + '</div></details>';
  return '<section class="activity-list"><div class="section-title">' + esc(title) + '<span>' + items.length + '</span></div>' + content + '</section>';
}

function refreshActivityContents() {
  const panel = $('#activity');
  const scroll = panel.querySelector('.activity-scroll');
  const previousScroll = scroll ? scroll.scrollTop : 0;
  const answerDrafts = new Map([...panel.querySelectorAll('[data-answer]')].map(control => [control.dataset.answer, control.value]));
  const openMissions = new Map([...panel.querySelectorAll('[data-mission-id]')].map(card => [card.dataset.missionId, card.open]));
  const recentArchiveOpen = !!panel.querySelector('.activity-archive[open]');
  const focusedAnswer = panel.contains(document.activeElement) && document.activeElement.dataset
    ? document.activeElement.dataset.answer
    : null;
  const filteredTasks = tasks.filter(matchesProjectFilter);
  const filteredMissions = missions.filter(matchesProjectFilter);
  const ordered = [...filteredTasks].sort((a, b) => activityPriority(a.status) - activityPriority(b.status) || (b.updatedAt || b.finishedAt || b.startedAt || 0) - (a.updatedAt || a.finishedAt || a.startedAt || 0));
  const waiting = ordered.filter(task => task.status === 'waiting_input').slice(0, 8);
  const active = ordered.filter(task => ['running', 'queued'].includes(task.status)).slice(0, 12);
  const recent = ordered.filter(task => !['waiting_input', 'running', 'queued'].includes(task.status)).slice(0, 8);
  const activeCount = waiting.length + active.length;
  const monitor = S.desktopMonitor || { ok: true };
  const monitorBanner = monitor.ok ? '' : '<div class="monitor-warning"><b>Codex Desktop 状态暂时不可用</b><span>' + esc(monitor.error || '已继续尝试重连') + '</span></div>';
  const empty = !filteredMissions.length && !interactions.length && !waiting.length && !active.length && !recent.length
    ? '<section class="activity-list"><div class="empty-state">' + (monitor.ok ? '当前没有进行中的任务' : '暂时无法确认 Codex Desktop 任务状态') + '</div></section>'
    : '';
  panel.innerHTML = '<header class="activity-head"><div><b>任务动态</b><small>' + (activeCount ? activeCount + ' 项正在进行' : '所有 Agent 的最近活动') + '</small></div><label class="activity-filter"><span>项目</span><select id="activity-project-filter">' + projectFilterOptions() + '</select></label><button class="close-btn" id="activity-close" aria-label="收起">⌄</button></header>' +
    '<div class="activity-scroll">' + monitorBanner +
    missionSectionHtml(filteredMissions) +
    (interactions.length ? '<section class="interaction-list"><div class="section-title">需要你处理<span>' + interactions.length + '</span></div>' + interactions.map(interactionCardHtml).join('') + '</section>' : '') +
    activitySectionHtml('等待处理', waiting) + activitySectionHtml('进行中', active) + activitySectionHtml('最近动态', recent, true) + empty + '</div>';
  bindActivity();
  panel.querySelectorAll('[data-answer]').forEach(control => {
    if (answerDrafts.has(control.dataset.answer)) control.value = answerDrafts.get(control.dataset.answer);
  });
  panel.querySelectorAll('[data-mission-id]').forEach(card => {
    if (openMissions.has(card.dataset.missionId)) card.open = openMissions.get(card.dataset.missionId);
  });
  const recentArchive = panel.querySelector('.activity-archive');
  if (recentArchive) recentArchive.open = recentArchiveOpen;
  const nextScroll = panel.querySelector('.activity-scroll');
  if (nextScroll) nextScroll.scrollTop = previousScroll;
  if (focusedAnswer) {
    const nextFocus = [...panel.querySelectorAll('[data-answer]')].find(control => control.dataset.answer === focusedAnswer);
    if (nextFocus) nextFocus.focus({ preventScroll: true });
  }
  if (activitySurface.state === 'open') applyActivityRect(activityTargetRect());
}

function cancelActivityMotion() {
  clearTimeout(activitySurface.timer);
  activitySurface.timer = null;
  if (activitySurface.animation) {
    activitySurface.animation.onfinish = null;
    try { activitySurface.animation.cancel(); } catch {}
  }
  activitySurface.animation = null;
  $('#activity').getAnimations().forEach(animation => {
    animation.onfinish = null;
    try { animation.cancel(); } catch {}
  });
}

function activityTargetRect() {
  const panel = $('#activity');
  const boss = pets.get('supervisor');
  if (!boss) return { left: 12, top: 12, width: Math.min(430, innerWidth - 24), height: Math.min(500, innerHeight - 24) };
  const quickbar = boss.el.querySelector('.quickbar').getBoundingClientRect();
  panel.style.width = Math.min(430, innerWidth - 24) + 'px';
  panel.style.height = 'auto';
  const height = Math.min(panel.scrollHeight, 500, Math.round(innerHeight * .62));
  const width = panel.offsetWidth;
  const left = Math.max(12, Math.min(innerWidth - width - 12, Math.round(quickbar.left + quickbar.width / 2 - width / 2)));
  const below = quickbar.bottom + 8;
  const top = below + height <= innerHeight - 10 ? below : Math.max(10, quickbar.top - height - 8);
  return { left, top, width, height };
}

function openActivity() {
  const panel = $('#activity');
  if (activitySurface.state === 'open' || activitySurface.state === 'opening') {
    closeActivity();
    return;
  }
  const reversing = activitySurface.state === 'closing' && !panel.classList.contains('hidden');
  const reverseFrom = reversing ? panel.getBoundingClientRect() : null;
  const epoch = ++activitySurface.epoch;
  cancelActivityMotion();
  activitySurface.state = 'opening';
  hideLiveTaskCard();
  $('#panel').classList.add('hidden');
  $('#ctxmenu').classList.add('hidden');
  closeComposer(true);
  openPanelFor = null;
  panel.className = 'ui pet-activity';
  panel.setAttribute?.('role', 'dialog');
  panel.setAttribute?.('aria-label', '任务动态');
  panel.classList.remove('hidden', 'ready');
  const boss = pets.get('supervisor');
  if (boss) boss.el.classList.add('activity-open');
  refreshActivityContents();
  const button = boss && boss.el.querySelector('[data-activity]');
  const anchor = button ? button.getBoundingClientRect() : { left: 12, top: 12, width: 36, height: 36 };
  const target = activityTargetRect();
  const start = reverseFrom || anchor;
  const finish = () => {
    if (epoch !== activitySurface.epoch || activitySurface.state !== 'opening') return;
    cancelActivityMotion();
    activitySurface.state = 'open';
    applyActivityRect(target);
    panel.classList.add('ready');
    syncMouseCapture(panel);
  };
  if (motionReduced()) {
    finish();
    return;
  }
  applyActivityRect(start);
  activitySurface.animation = panel.animate([
    { left: start.left + 'px', top: start.top + 'px', width: start.width + 'px', height: start.height + 'px', borderRadius: reversing ? '20px' : '999px', opacity: reversing ? .82 : .45 },
    { left: target.left + 'px', top: target.top + 'px', width: target.width + 'px', height: target.height + 'px', borderRadius: '20px', opacity: 1 },
  ], { duration: reversing ? 190 : 260, easing: 'cubic-bezier(.22,.86,.24,1)', fill: 'both' });
  activitySurface.animation.onfinish = finish;
  activitySurface.timer = setTimeout(finish, reversing ? 240 : 320);
  syncMouseCapture(panel);
}

function applyActivityRect(rect) {
  const panel = $('#activity');
  panel.style.left = Math.round(rect.left) + 'px';
  panel.style.top = Math.round(rect.top) + 'px';
  panel.style.width = Math.round(rect.width) + 'px';
  panel.style.height = Math.round(rect.height) + 'px';
}

function closeActivity(immediate = false) {
  const panel = $('#activity');
  if (activitySurface.state === 'closed') return;
  const current = panel.getBoundingClientRect();
  const epoch = ++activitySurface.epoch;
  cancelActivityMotion();
  activitySurface.state = 'closing';
  const boss = pets.get('supervisor');
  const button = boss && boss.el.querySelector('[data-activity]');
  const finish = () => {
    if (epoch !== activitySurface.epoch || activitySurface.state !== 'closing') return;
    cancelActivityMotion();
    activitySurface.state = 'closed';
    panel.className = 'hidden ui';
    panel.removeAttribute('style');
    if (boss) boss.el.classList.remove('activity-open');
    updateLiveTaskCard();
    syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y));
  };
  if (immediate || motionReduced() || !button) {
    finish();
    return;
  }
  const anchor = button.getBoundingClientRect();
  panel.classList.remove('ready');
  activitySurface.animation = panel.animate([
    { left: current.left + 'px', top: current.top + 'px', width: current.width + 'px', height: current.height + 'px', borderRadius: '20px', opacity: 1 },
    { left: anchor.left + 'px', top: anchor.top + 'px', width: anchor.width + 'px', height: anchor.height + 'px', borderRadius: '999px', opacity: .25 },
  ], { duration: 210, easing: 'cubic-bezier(.4,0,.8,.2)', fill: 'both' });
  activitySurface.animation.onfinish = finish;
  activitySurface.timer = setTimeout(finish, 270);
}

function bindActivity() {
  const panel = $('#activity');
  panel.querySelector('#activity-close').onclick = () => {
    closeActivity();
  };
  panel.querySelectorAll('[data-activity-thread]').forEach(button => {
    button.onclick = () => openCodexThread(button.dataset.activityThread);
  });
  const projectFilter = panel.querySelector('#activity-project-filter');
  if (projectFilter) projectFilter.onchange = async () => {
    S.ui.taskProjectFilter = projectFilter.value;
    await window.petOffice.setUi({ taskProjectFilter: projectFilter.value });
    refreshActivityContents();
  };
  panel.querySelectorAll('[data-pin-task]').forEach(button => {
    button.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      setPinnedLiveTask(button.dataset.pinTask);
    };
  });
  panel.querySelectorAll('[data-mission-confirm]').forEach(button => { button.onclick = async () => { await window.petOffice.confirmMission(button.dataset.missionConfirm); }; });
  panel.querySelectorAll('[data-mission-regenerate]').forEach(button => { button.onclick = async () => { button.disabled = true; await window.petOffice.regenerateMission(button.dataset.missionRegenerate); }; });
  panel.querySelectorAll('[data-mission-resume]').forEach(button => { button.onclick = async () => { await window.petOffice.resumeMission(button.dataset.missionResume); }; });
  panel.querySelectorAll('[data-mission-cancel]').forEach(button => { button.onclick = async () => { await window.petOffice.cancelMission(button.dataset.missionCancel); }; });
  panel.querySelectorAll('[data-mission-apply]').forEach(button => { button.onclick = async () => { await window.petOffice.resolveMission(button.dataset.missionApply, 'apply'); }; });
  panel.querySelectorAll('[data-mission-resolved]').forEach(button => { button.onclick = async () => { await window.petOffice.resolveMission(button.dataset.missionResolved, 'mark-resolved'); }; });
  const respond = async (button, payload) => {
    const card = button.closest('[data-interaction-card]');
    card.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
    const result = await window.petOffice.respondInteraction(payload);
    if (!result || !result.ok) {
      card.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; });
      bubble('supervisor', (result && result.error) || '处理失败', 6000);
    }
  };
  panel.querySelectorAll('[data-interaction-approve]').forEach(button => {
    button.onclick = () => respond(button, { id: button.dataset.interactionApprove, approved: true });
  });
  panel.querySelectorAll('[data-interaction-deny]').forEach(button => {
    button.onclick = () => respond(button, { id: button.dataset.interactionDeny, approved: false });
  });
  panel.querySelectorAll('[data-answer-submit]').forEach(button => {
    button.onclick = () => {
      const card = button.closest('[data-interaction-card]');
      const answers = {};
      card.querySelectorAll('[data-answer]').forEach(control => { answers[control.dataset.answer] = control.value; });
      respond(button, { id: button.dataset.answerSubmit, answers });
    };
  });
}

function openPanel(petId, requestedTab) {
  const pet = pets.get(petId);
  if (!pet) return;
  openPanelFor = petId;
  hideLiveTaskCard();
  closeActivity(true);
  $('#ctxmenu').classList.add('hidden');
  const panel = $('#panel');
  const tabs = pet.role === 'supervisor'
    ? [['overview', '概览'], ['work', '工作'], ['team', '团队'], ['appearance', '形象'], ['settings', '设置']]
    : [['overview', '概览'], ['work', '工作'], ['appearance', '形象'], ['settings', '设置']];
  const allowed = tabs.map(tab => tab[0]);
  const tab = allowed.includes(requestedTab) ? requestedTab : (panelTabs.get(petId) || 'overview');
  panelTabs.set(petId, tab);

  let html = '<header class="panel-head"><div class="mini-avatar ' + pet.role + '"><span>›_</span></div><div><b>' + esc(pet.name) + '</b><small>' + (pet.role === 'supervisor' ? '主管 Agent' : '工作者 Agent') + '</small></div><button class="close-btn" id="p-close" aria-label="关闭">×</button></header>';
  html += '<nav class="panel-tabs">' + tabs.map(item => '<button data-panel-tab="' + item[0] + '" class="' + (tab === item[0] ? 'active' : '') + '">' + item[1] + '</button>').join('') + '</nav>';
  html += '<div class="panel-page">' + panelPage(pet, tab) + '</div>';
  panel.innerHTML = html;
  panel.setAttribute?.('role', 'dialog');
  panel.setAttribute?.('aria-label', pet.name + ' 设置');
  panel.classList.remove('hidden');
  positionPanel(panel, pet.el);
  bindPanel(petId);
  syncMouseCapture(panel);
  if (tab === 'work' && pet.role === 'supervisor') {
    const project = currentProject();
    if (project && !projectSessionCache.has(project.id) && !projectSessionLoading.has(project.id)) {
      projectSessionLoading.add(project.id);
      window.petOffice.listSessions(project.id).then(items => {
        projectSessionCache.set(project.id, Array.isArray(items) ? items : []);
      }).catch(() => {
        projectSessionCache.set(project.id, []);
      }).finally(() => {
        projectSessionLoading.delete(project.id);
        if (openPanelFor === petId && panelTabs.get(petId) === 'work' && currentProject() && currentProject().id === project.id) openPanel(petId, 'work');
      });
    }
  }
  if (tab === 'settings' && pet.role === 'supervisor' && !diagnosticsReport && !diagnosticsInFlight) {
    diagnosticsInFlight = true;
    window.petOffice.diagnostics().then(report => {
      diagnosticsReport = report;
    }).catch(() => {}).finally(() => {
      diagnosticsInFlight = false;
      if (openPanelFor === petId && panelTabs.get(petId) === 'settings') openPanel(petId, 'settings');
    });
  }
}

function diagnosticsHtml() {
  if (!diagnosticsReport) {
    return '<div class="diagnostics-card"><div class="diagnostics-head"><b>连接诊断</b><button class="btn compact" id="p-diagnostics">检测</button></div><div class="diagnostics-loading">正在检查 Codex 与 OpenCodex…</div></div>';
  }
  const items = diagnosticsReport.items || [];
  return '<div class="diagnostics-card"><div class="diagnostics-head"><b>连接诊断</b><button class="btn compact" id="p-diagnostics">重新检测</button></div>' +
    '<div class="diagnostics-list">' + items.map(item => '<div class="diagnostic-row ' + esc(item.status) + '"><i></i><span><b>' + esc(item.label) + '</b><small>' + esc(item.detail) + '</small></span></div>').join('') + '</div>' +
    '<small class="diagnostics-time">检测于 ' + esc(new Date(diagnosticsReport.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })) + '</small></div>';
}

function panelPage(pet, tab) {
  const myTasks = tasks.filter(task => task.petId === pet.id);
  const current = myTasks.find(task => ['queued', 'running', 'waiting_input'].includes(task.status));
  if (tab === 'overview') {
    return '<div class="hero-status"><span class="status-dot ' + pet.status + '"></span><div><b>' + esc(STATUS_TEXT[pet.status] || '待命') + '</b><small>' + (current ? esc(short(current.brief, 72)) : '等待你的下一条消息') + '</small></div></div>' +
      '<label class="field"><span>当前模型</span><select id="p-model">' + modelOptions(pet.model) + '</select></label>' +
      capabilityBadges(pet.model) +
      quotaBlock(pet.model) +
      '<div class="overview-actions"><button class="btn primary overview-primary" id="p-newtask">✎ 继续对话</button><div class="overview-secondary"><button class="btn" id="p-fresh-chat">新会话</button><button class="btn" id="p-activity">任务动态</button></div><details class="utility-actions"><summary>更多操作</summary><div><button class="text-btn" id="p-opencodex">在 Codex 中打开</button><button class="text-btn danger-text" id="p-reset-chat">重置当前上下文</button></div></details></div>';
  }
  if (tab === 'work') {
    let content = '';
    if (pet.role === 'supervisor') {
      const project = currentProject();
      content += '<label class="field"><span>当前项目</span><select id="p-project">' + projectOptions() + '</select></label>' +
        '<div class="project-path">' + esc(project ? project.path : '请新建或添加一个项目工作区') + '</div>' +
        '<div class="button-row"><button class="btn" id="p-newproj">新建项目</button><button class="btn" id="p-addproj">添加文件夹</button><button class="btn" id="p-openproj">打开目录</button></div>' + projectManagementHtml(project);
      for (const task of myTasks.filter(task => task.source === 'pet-chat' && ['queued', 'running', 'waiting_input'].includes(task.status))) {
        content += '<button class="btn danger wide" data-cancel="' + esc(task.id) + '">取消对话 · ' + esc(short(task.brief, 36)) + '</button>';
      }
    } else {
      content += '<label class="field"><span>用量上限（tokens）</span><input id="p-cap" type="number" min="0" step="10000" value="' + ((S.caps || {})[pet.id] || '') + '" placeholder="留空表示不限"></label>' +
        '<div class="metric-row"><span>累计记录</span><b>' + myTasks.reduce((total, task) => total + (task.tokens || 0), 0) + ' tokens</b></div>';
      for (const task of myTasks.filter(task => ['queued', 'running', 'waiting_input'].includes(task.status))) {
        content += '<button class="btn danger wide" data-cancel="' + esc(task.id) + '">取消当前任务</button>';
      }
    }
    return content + '<div class="section-title">最近任务</div>' + recentTasksFor(pet.role === 'supervisor' ? null : pet.id, 7);
  }
  if (tab === 'team') {
    return '<div class="mode-card"><div><b>分工模式</b><small>开启后可选择多个 Agent 并行执行</small></div>' + switchHtml('p-delegation', delegationOn) + '</div>' +
      '<div class="section-title">成员</div><div class="member-list">' + S.pets.workers.map(worker => {
        const workerPet = pets.get(worker.id);
        const hidden = workerPet.el.classList.contains('hidden-pet');
        return '<div class="member-row"><span class="member-color c-' + worker.id + '"></span><div><b>' + esc(workerPet.name) + '</b><small>' + esc(modelName(workerPet.model)) + '</small></div><button class="btn compact" data-toggle-worker="' + worker.id + '">' + (hidden ? '召唤' : '隐藏') + '</button></div>';
      }).join('') + '</div><div class="button-row"><button class="btn" id="p-summon-all">召唤全部</button><button class="btn" id="p-hide-workers">收起全部</button></div>';
  }
  if (tab === 'appearance') return appearancePage(pet);
  return '<label class="field"><span>名称</span><div class="inline-field"><input id="p-name" type="text" value="' + esc(pet.name) + '"><button class="btn" id="p-rename">保存</button></div></label>' +
    (pet.role === 'supervisor' ?
      '<div class="settings-list"><label><span>开机自启<small>登录 Windows 后启动 Pet Office</small></span>' + switchHtml('s-autostart', S.settings.autostart) + '</label>' +
      '<label class="field"><span>界面主题<small>任务中心始终保持深色，确保进度可读</small></span><select id="s-theme">' + selectOptions([['warm', '温暖办公室'], ['dark', '深色工作台'], ['system', '跟随系统']], S.settings.themeMode || 'warm') + '</select></label>' +
      '<label><span>迷你模式<small>缩小桌宠并隐藏常驻名称，悬停时恢复</small></span>' + switchHtml('s-compact', S.settings.compactMode) + '</label>' +
      '<label><span>减少动画<small>停用循环逐帧和位移动画，适合游戏或录屏</small></span>' + switchHtml('s-reduced-motion', S.settings.reducedMotion) + '</label>' +
      '<label class="field"><span>桌宠大小<small>迷你模式会在此基础上进一步缩小</small></span><select id="s-pet-scale">' + scaleOptions(S.settings.petScale) + '</select></label>' +
      '<label class="field"><span>显示器<small>切换后桌宠会安全移动到目标工作区</small></span><select id="s-display">' + displayOptions(S.settings.displayMode) + '</select></label>' +
      '<label class="field"><span>全屏应用避让<small>检测到游戏、演示或视频全屏时的行为</small></span><select id="s-fullscreen">' + selectOptions([['corner', '只保留主管并避让到角落'], ['hide', '暂时完全隐藏'], ['ignore', '保持原样']], S.settings.fullscreenBehavior) + '</select></label>' +
      '<label class="field"><span>通知详细程度<small>安静模式仅显示需要处理和错误</small></span><select id="s-notification">' + selectOptions([['quiet', '安静'], ['standard', '标准'], ['detailed', '详细']], S.settings.notificationMode) + '</select></label>' +
      '<label class="field"><span>界面字号</span><select id="s-font-scale">' + selectOptions([[.9, '紧凑 90%'], [1, '标准 100%'], [1.1, '较大 110%'], [1.2, '大号 120%']], Number(S.settings.fontScale) || 1) + '</select></label>' +
      '<label class="field"><span>界面字体</span><select id="s-font-family">' + selectOptions([['system', '系统默认'], ['rounded', '圆润'], ['readable', '高可读']], S.settings.fontFamily) + '</select></label>' +
      '<label><span>自动检查更新<small>仅查询 GitHub Release；下载与安装始终由你确认</small></span>' + switchHtml('s-auto-update', S.settings.autoCheckUpdates !== false) + '</label>' +
      '<label class="field"><span>显示 / 隐藏快捷键<small>' + esc(shortcutHint()) + '</small></span><select id="s-shortcut">' + shortcutOptions(S.settings.toggleShortcut) + '</select></label>' +
      '<label class="field"><span>截图提问快捷键<small>' + esc(captureShortcutHint()) + '</small></span><select id="s-capture-shortcut">' + captureShortcutOptions(S.settings.captureShortcut) + '</select></label>' +
      '<label class="field"><span>最大并行 Agent</span><input id="s-mp" type="number" min="1" max="5" value="' + S.settings.maxParallel + '"></label></div>' +
      diagnosticsHtml() +
      releaseHtml() +
      '<div class="danger-zone"><b>应用控制</b><div class="button-row"><button class="btn" id="p-hide-app">隐藏到托盘</button><button class="btn danger" id="p-quit">退出 Pet Office</button></div></div>' :
      '<button class="btn wide" id="p-hide-worker">隐藏该桌宠（任务继续）</button>');
}

function appearancePage(pet) {
  const cards = [
    '<button class="skin-card' + (!pet.skin ? ' selected' : '') + '" data-skin-choice="" aria-pressed="' + (!pet.skin ? 'true' : 'false') + '"><span class="skin-card-check">✓</span><span class="skin-card-preview default-skin-preview"><i>›_</i></span><b>Pet Office</b><small>默认形象</small></button>',
    ...(S.skins || []).map(skin => '<button class="skin-card' + (skin.slug === pet.skin ? ' selected' : '') + '" data-skin-choice="' + esc(skin.slug) + '" aria-pressed="' + (skin.slug === pet.skin ? 'true' : 'false') + '"><span class="skin-card-check">✓</span><span class="skin-card-preview" data-skin-preview="' + esc(skin.slug) + '"></span><b>' + esc(skin.name) + '</b><small>' + esc(skin.author ? '作者 · ' + skin.author : 'Petdex 形象') + '</small></button>'),
    '<button class="skin-card discover-skin" data-discover-skins><span class="discover-icon">＋</span><b>发现形象</b><small>前往 Petdex 浏览更多</small></button>',
  ];
  return '<div class="appearance-intro"><div><b>选择 ' + esc(pet.name) + ' 的形象</b><small>已安装的 Petdex 形象会自动出现在这里</small></div><div class="appearance-actions"><span>' + ((S.skins || []).length + 1) + ' 个可选</span><button class="btn compact" id="p-refresh-skins" title="重新扫描本地 Petdex 形象">刷新</button></div></div><div class="skin-gallery">' + cards.join('') + '</div>';
}

function hydrateAppearancePreviews(root) {
  root.querySelectorAll('[data-skin-preview]').forEach(preview => {
    const skin = skinRecord(preview.dataset.skinPreview);
    if (!skin) return;
    preview.classList.add('loading');
    appearancePreviewUrl(skin).then(source => {
      if (!preview.isConnected || preview.dataset.skinPreview !== skin.slug) return;
      preview.style.backgroundImage = 'url("' + source.replace(/"/g, '%22') + '")';
      preview.style.backgroundSize = 'contain';
      preview.style.backgroundPosition = 'center';
      preview.style.backgroundRepeat = 'no-repeat';
      preview.classList.remove('loading');
    }).catch(() => {
      if (!preview.isConnected) return;
      preview.style.backgroundImage = 'url("' + skin.assetUrl.replace(/"/g, '%22') + '")';
      preview.style.backgroundSize = (skin.columns || 8) * 100 + '% ' + (skin.rows || 9) * 100 + '%';
      preview.style.backgroundPosition = '0 0';
      preview.classList.remove('loading');
    });
  });
}

function appearancePreviewUrl(skin) {
  if (skinPreviewCache.has(skin.slug)) return skinPreviewCache.get(skin.slug);
  const pending = window.petOffice.skinData(skin.slug).then(dataUrl => {
    if (!dataUrl) throw new Error('skin data unavailable');
    return loadImageElement(dataUrl);
  }).then(image => {
    const columns = Math.max(1, Number(skin.columns) || 8);
    const rows = Math.max(1, Number(skin.rows) || 9);
    const frameWidth = Math.max(1, Math.min(Number(skin.frameWidth) || image.naturalWidth / columns, image.naturalWidth));
    const frameHeight = Math.max(1, Math.min(Number(skin.frameHeight) || image.naturalHeight / rows, image.naturalHeight));
    const sheet = document.createElement('canvas');
    sheet.width = image.naturalWidth;
    sheet.height = image.naturalHeight;
    const context = sheet.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    let crop = null;
    for (let row = 0; row < rows && !crop; row++) {
      for (let column = 0; column < columns; column++) {
        const x = Math.round(column * frameWidth);
        const y = Math.round(row * frameHeight);
        const width = Math.max(1, Math.round(frameWidth));
        const height = Math.max(1, Math.round(frameHeight));
        const pixels = context.getImageData(x, y, width, height).data;
        const bounds = alphaBoundsFromPixels(pixels, width, height);
        if (!bounds) continue;
        crop = { x: x + bounds.x, y: y + bounds.y, width: bounds.width, height: bounds.height };
        break;
      }
    }
    if (!crop) crop = { x: 0, y: 0, width: frameWidth, height: frameHeight };
    const output = document.createElement('canvas');
    output.width = 116;
    output.height = 116;
    const out = output.getContext('2d');
    out.imageSmoothingEnabled = false;
    const scale = Math.min(104 / crop.width, 104 / crop.height);
    const width = Math.max(1, Math.round(crop.width * scale));
    const height = Math.max(1, Math.round(crop.height * scale));
    out.drawImage(image, crop.x, crop.y, crop.width, crop.height, Math.round((116 - width) / 2), Math.round((116 - height) / 2), width, height);
    return output.toDataURL('image/png');
  });
  skinPreviewCache.set(skin.slug, pending);
  return pending;
}

function alphaBoundsFromPixels(pixels, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaque = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] <= 20) continue;
      opaque++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (opaque < 24 || maxX < minX || maxY < minY) return null;
  const pad = 3;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return { x, y, width: Math.min(width - x, maxX - minX + 1 + pad * 2), height: Math.min(height - y, maxY - minY + 1 + pad * 2) };
}

function switchHtml(id, checked) {
  return '<label class="switch"><input id="' + id + '" type="checkbox"' + (checked ? ' checked' : '') + '><span></span></label>';
}

function scaleOptions(selected) {
  const value = Number(selected) || 1;
  return [[.8, '小'], [1, '标准'], [1.2, '大'], [1.4, '特大']]
    .map(([scale, label]) => '<option value="' + scale + '"' + (Math.abs(scale - value) < .01 ? ' selected' : '') + '>' + label + ' · ' + Math.round(scale * 100) + '%</option>')
    .join('');
}

function shortcutOptions(selected) {
  return SHORTCUT_OPTIONS.map(([value, label]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + label + '</option>').join('');
}

function shortcutHint() {
  const status = S.shortcutStatus || {};
  if (!status.ok) return '快捷键注册失败；可尝试其他组合。退出固定为 Ctrl + Alt + Q';
  if (status.fallback) return '所选组合被占用，当前暂用 Ctrl + Alt + P';
  return '当前：' + (SHORTCUT_OPTIONS.find(item => item[0] === (status.active || S.settings.toggleShortcut)) || ['', 'Ctrl + Alt + P'])[1] + '；退出固定为 Ctrl + Alt + Q';
}

function captureShortcutOptions(selected) {
  return CAPTURE_SHORTCUT_OPTIONS.map(([value, label]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' + label + '</option>').join('');
}

function captureShortcutHint() {
  const status = S.shortcutStatus || {};
  if (!status.captureOk) return '截图快捷键注册失败；可尝试其他组合，或右键桌宠启动截图。';
  if (status.captureFallback) return '所选组合被占用，当前暂用 Ctrl + Alt + S';
  const found = CAPTURE_SHORTCUT_OPTIONS.find(item => item[0] === (status.captureActive || S.settings.captureShortcut));
  return '当前：' + (found ? found[1] : 'Ctrl + Alt + S') + '；也可在输入框输入 /截图';
}

function positionPanel(panel, petElement) {
  const rect = petElement.getBoundingClientRect();
  const leftSide = rect.left - panel.offsetWidth - 16;
  const rightSide = rect.right + 16;
  panel.style.left = Math.round(leftSide >= 12 ? leftSide : Math.min(rightSide, innerWidth - panel.offsetWidth - 12)) + 'px';
  panel.style.top = Math.round(Math.max(12, Math.min(rect.top + rect.height / 2 - panel.offsetHeight / 2, innerHeight - panel.offsetHeight - 12))) + 'px';
}

function bindPanel(petId) {
  const panel = $('#panel');
  const pet = pets.get(petId);
  hydrateAppearancePreviews(panel);
  panel.querySelector('#p-close').onclick = () => {
    panel.classList.add('hidden');
    openPanelFor = null;
    updateLiveTaskCard();
    syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y));
  };
  panel.querySelectorAll('[data-panel-tab]').forEach(button => {
    button.onclick = () => openPanel(petId, button.dataset.panelTab);
  });

  const modelSelect = panel.querySelector('#p-model');
  if (modelSelect) modelSelect.onchange = async event => {
    const previousProvider = providerOf(pet.model);
    pet.model = event.target.value || null;
    await window.petOffice.setModel(petId, pet.model);
    openPanel(petId);
    if (providerOf(pet.model) !== previousProvider) {
      S.quotas = await window.petOffice.refreshQuota();
      if (openPanelFor === petId) openPanel(petId);
    }
  };
  const refreshButton = panel.querySelector('#quota-refresh');
  if (refreshButton) refreshButton.onclick = async () => {
    refreshButton.classList.add('spinning');
    S.quotas = await window.petOffice.refreshQuota();
    if (openPanelFor === petId) openPanel(petId);
  };
  panel.querySelectorAll('[data-cancel]').forEach(button => {
    button.onclick = () => window.petOffice.cancelTask(button.dataset.cancel);
  });
  panel.querySelectorAll('[data-thread-task]').forEach(button => {
    button.onclick = () => {
      const task = tasks.find(item => item.id === button.dataset.threadTask);
      if (task && task.threadId) openCodexThread(task.threadId);
    };
  });
  panel.querySelectorAll('[data-result-task]').forEach(button => {
    button.onclick = () => {
      const task = tasks.find(item => item.id === button.dataset.resultTask);
      if (task && task.resultPath) window.petOffice.openPath(task.resultPath);
    };
  });

  const newTask = panel.querySelector('#p-newtask');
  if (newTask) newTask.onclick = () => openComposer(petId, delegationOn);
  const freshChat = panel.querySelector('#p-fresh-chat');
  if (freshChat) freshChat.onclick = () => startNewConversation(petId, false);
  const resetChat = panel.querySelector('#p-reset-chat');
  if (resetChat) resetChat.onclick = () => resetConversationContext(petId);
  const openCodex = panel.querySelector('#p-opencodex');
  if (openCodex) openCodex.onclick = () => openLatestThread(petId);
  const activity = panel.querySelector('#p-activity');
  if (activity) activity.onclick = () => openActivity();
  const cap = panel.querySelector('#p-cap');
  if (cap) cap.onchange = () => window.petOffice.setCap(petId, cap.value ? Number(cap.value) : null);
  const rename = panel.querySelector('#p-rename');
  if (rename) rename.onclick = async () => {
    const value = panel.querySelector('#p-name').value.trim();
    if (value && await window.petOffice.renamePet(petId, value)) {
      pet.name = value;
      pet.el.querySelector('.tag').innerHTML = esc(value) + '<span class="dot"></span>';
      openPanel(petId);
    }
  };
  panel.querySelectorAll('[data-skin-choice]').forEach(card => {
    card.onclick = async () => {
      const nextSkin = card.dataset.skinChoice || null;
      if (nextSkin === pet.skin || (!nextSkin && !pet.skin)) return;
      panel.querySelectorAll('[data-skin-choice]').forEach(item => { item.disabled = true; });
      pet.skin = nextSkin;
      await window.petOffice.setSkin(petId, pet.skin);
      applySkin(pet);
      openPanel(petId, 'appearance');
    };
  });
  const discoverSkins = panel.querySelector('[data-discover-skins]');
  if (discoverSkins) discoverSkins.onclick = () => window.petOffice.openPetdex();
  const refreshSkins = panel.querySelector('#p-refresh-skins');
  if (refreshSkins) refreshSkins.onclick = async () => {
    refreshSkins.disabled = true;
    refreshSkins.textContent = '扫描中';
    S.skins = await window.petOffice.refreshSkins();
    openPanel(petId, 'appearance');
  };

  bindProjectControls(panel, petId);
  const delegation = panel.querySelector('#p-delegation');
  if (delegation) delegation.onchange = () => setDelegationMode(delegation.checked, true);
  panel.querySelectorAll('[data-toggle-worker]').forEach(button => {
    button.onclick = () => {
      const id = button.dataset.toggleWorker;
      if (pets.get(id).el.classList.contains('hidden-pet')) summonWorkers([id], true);
      else hideWorker(id, true);
      setTimeout(() => openPanel(petId, 'team'), 140);
    };
  });
  const summonAll = panel.querySelector('#p-summon-all');
  if (summonAll) summonAll.onclick = () => { summonWorkers(['w1', 'w2', 'w3', 'w4'], true); setTimeout(() => openPanel(petId, 'team'), 150); };
  const hideWorkers = panel.querySelector('#p-hide-workers');
  if (hideWorkers) hideWorkers.onclick = () => { ['w1', 'w2', 'w3', 'w4'].forEach(id => hideWorker(id, true)); setTimeout(() => openPanel(petId, 'team'), 150); };

  const autostart = panel.querySelector('#s-autostart');
  if (autostart) autostart.onchange = () => saveSettings({ autostart: autostart.checked }, petId);
  const compact = panel.querySelector('#s-compact');
  if (compact) compact.onchange = () => saveSettings({ compactMode: compact.checked }, petId);
  const reducedMotion = panel.querySelector('#s-reduced-motion');
  if (reducedMotion) reducedMotion.onchange = () => saveSettings({ reducedMotion: reducedMotion.checked }, petId);
  const theme = panel.querySelector('#s-theme');
  if (theme) theme.onchange = () => saveSettings({ themeMode: theme.value }, petId);
  const petScale = panel.querySelector('#s-pet-scale');
  if (petScale) petScale.onchange = () => saveSettings({ petScale: Number(petScale.value) || 1 }, petId);
  const display = panel.querySelector('#s-display');
  if (display) display.onchange = () => saveSettings({ displayMode: display.value }, petId);
  const fullscreen = panel.querySelector('#s-fullscreen');
  if (fullscreen) fullscreen.onchange = () => saveSettings({ fullscreenBehavior: fullscreen.value }, petId);
  const notification = panel.querySelector('#s-notification');
  if (notification) notification.onchange = () => saveSettings({ notificationMode: notification.value }, petId);
  const fontScale = panel.querySelector('#s-font-scale');
  if (fontScale) fontScale.onchange = () => saveSettings({ fontScale: Number(fontScale.value) || 1 }, petId);
  const fontFamily = panel.querySelector('#s-font-family');
  if (fontFamily) fontFamily.onchange = () => saveSettings({ fontFamily: fontFamily.value }, petId);
  const autoUpdate = panel.querySelector('#s-auto-update');
  if (autoUpdate) autoUpdate.onchange = () => saveSettings({ autoCheckUpdates: autoUpdate.checked }, petId);
  const shortcut = panel.querySelector('#s-shortcut');
  if (shortcut) shortcut.onchange = () => saveSettings({ toggleShortcut: shortcut.value }, petId);
  const captureShortcut = panel.querySelector('#s-capture-shortcut');
  if (captureShortcut) captureShortcut.onchange = () => saveSettings({ captureShortcut: captureShortcut.value }, petId);
  const maxParallel = panel.querySelector('#s-mp');
  if (maxParallel) maxParallel.onchange = () => saveSettings({ maxParallel: Math.max(1, Math.min(5, Number(maxParallel.value) || 5)) }, petId);
  const runDiagnostics = panel.querySelector('#p-diagnostics');
  if (runDiagnostics) runDiagnostics.onclick = async () => {
    runDiagnostics.disabled = true;
    runDiagnostics.textContent = '检测中…';
    diagnosticsInFlight = true;
    try { diagnosticsReport = await window.petOffice.diagnostics(); } catch { diagnosticsReport = null; }
    diagnosticsInFlight = false;
    if (openPanelFor === petId) openPanel(petId, 'settings');
  };
  const checkUpdate = panel.querySelector('#p-check-update');
  if (checkUpdate) checkUpdate.onclick = async () => {
    checkUpdate.disabled = true;
    checkUpdate.textContent = '检查中…';
    S.release = await window.petOffice.checkUpdates();
    if (openPanelFor === petId) openPanel(petId, 'settings');
  };
  const openRelease = panel.querySelector('#p-open-release');
  if (openRelease) openRelease.onclick = () => window.petOffice.openRelease();
  const openCrashes = panel.querySelector('#p-open-crashes');
  if (openCrashes) openCrashes.onclick = () => window.petOffice.openCrashes();
  const hideApp = panel.querySelector('#p-hide-app');
  if (hideApp) hideApp.onclick = () => window.petOffice.hideApp();
  const quit = panel.querySelector('#p-quit');
  if (quit) quit.onclick = () => window.petOffice.quit();
  const hideThisWorker = panel.querySelector('#p-hide-worker');
  if (hideThisWorker) hideThisWorker.onclick = () => { panel.classList.add('hidden'); hideWorker(petId, true); };
}

async function saveSettings(patch, petId) {
  const next = await window.petOffice.setSettings(patch);
  if (next && next.settings) {
    S.settings = next.settings;
    S.shortcutStatus = next.shortcutStatus || S.shortcutStatus;
    applyAppearanceSettings();
  }
  if (petId && openPanelFor === petId) openPanel(petId, 'settings');
}

function bindProjectControls(root, petId) {
  const select = root.querySelector('#p-project');
  if (select) select.onchange = async event => {
    if (!event.target.value) return;
    const selected = await window.petOffice.selectProject(event.target.value);
    if (!selected) return;
    S.activeProjectId = event.target.value;
    openPanel(petId, 'work');
  };
  const create = root.querySelector('#p-newproj');
  if (create) create.onclick = async () => {
    const name = await promptText('新建项目', '输入项目名称');
    if (!name) return;
    const project = await window.petOffice.createProject(name);
    if (project) {
      S.projects = [...(S.projects || []).filter(item => item.id !== project.id), project];
      S.activeProjectId = project.id;
      openPanel(petId, 'work');
    }
  };
  const add = root.querySelector('#p-addproj');
  if (add) add.onclick = async () => {
    const project = await window.petOffice.addProject();
    if (project) {
      S.projects = [...(S.projects || []).filter(item => item.id !== project.id), project];
      S.activeProjectId = project.id;
      openPanel(petId, 'work');
    }
  };
  const open = root.querySelector('#p-openproj');
  if (open) open.onclick = () => {
    const project = currentProject();
    if (project) window.petOffice.openPath(project.path);
  };
  root.querySelectorAll('[data-project-thread]').forEach(button => { button.onclick = () => openCodexThread(button.dataset.projectThread); });
  const renameProject = root.querySelector('#p-rename-project');
  if (renameProject) renameProject.onclick = async () => {
    const project = currentProject();
    const name = project && await promptText('重命名项目', project.name);
    if (!project || !name) return;
    const result = await window.petOffice.renameProject(project.id, name);
    if (!result || !result.ok) return bubble('supervisor', (result && result.error) || '重命名失败', 6000);
    await refreshState();
  };
  const archiveProject = root.querySelector('#p-archive-project');
  if (archiveProject) archiveProject.onclick = async () => {
    const project = currentProject();
    if (!project || !await confirmAction('归档项目', '归档只会从日常列表隐藏“' + project.name + '”，不会删除文件或 Codex 会话。', '归档')) return;
    const result = await window.petOffice.archiveProject(project.id, true);
    if (!result || !result.ok) return bubble('supervisor', (result && result.error) || '归档失败', 6500);
    projectSessionCache.delete(project.id);
    await refreshState();
    if (pets.get('supervisor')) openPanel('supervisor', 'work');
  };
  const clearAttachments = root.querySelector('#p-clear-attachments');
  if (clearAttachments) clearAttachments.onclick = async () => {
    const project = currentProject();
    if (!project || !await confirmAction('清理项目附件', '仅删除“' + project.name + '”项目 inbox 目录内的附件副本。项目源码、会话和 Mission 不受影响。', '清理附件')) return;
    const result = await window.petOffice.clearAttachments(project.id);
    bubble('supervisor', result && result.ok ? '已清理 ' + result.count + ' 项附件' : ((result && result.error) || '清理失败'), 6500);
  };
  const removeProject = root.querySelector('#p-remove-project');
  if (removeProject) removeProject.onclick = async () => {
    const project = currentProject();
    if (!project || !await confirmAction('从 Pet Office 移除', '只移除项目记录；磁盘目录“' + project.path + '”会完整保留。以后可重新添加。', '移除记录')) return;
    const result = await window.petOffice.removeProject(project.id);
    if (!result || !result.ok) return bubble('supervisor', (result && result.error) || '移除失败', 6500);
    projectSessionCache.delete(project.id);
    await refreshState();
    if (pets.get('supervisor')) openPanel('supervisor', 'work');
  };
  root.querySelectorAll('[data-restore-project]').forEach(button => {
    button.onclick = async () => {
      const result = await window.petOffice.archiveProject(button.dataset.restoreProject, false);
      if (!result || !result.ok) return bubble('supervisor', (result && result.error) || '恢复失败', 6000);
      await refreshState();
      openPanel('supervisor', 'work');
    };
  });
  const newSession = root.querySelector('#p-new-session');
  if (newSession) newSession.onclick = () => startNewConversation('supervisor', false);
  const resetContext = root.querySelector('#p-reset-context');
  if (resetContext) resetContext.onclick = () => resetConversationContext('supervisor');
}

async function openCodexThread(threadId) {
  const result = await window.petOffice.openCodex(threadId || null);
  if (!result || result.ok !== false) return result;
  if (result.code !== 'ACTIVE_PET_CHAT') {
    bubble('supervisor', result.error || '无法打开 Codex', 7000);
    return result;
  }
  const confirmed = await confirmAction(
    '移交到 Codex Desktop',
    '当前回合仍在由桌宠执行。移交会先中断这一回合、释放线程写入权，然后在 Codex 中打开原会话。',
    '停止并移交'
  );
  if (!confirmed) return result;
  const handoff = await window.petOffice.handoffChat(result.taskId);
  if (!handoff || !handoff.ok) bubble('supervisor', (handoff && handoff.error) || '移交失败', 7000);
  else bubble('supervisor', '已移交到 Codex Desktop', 5000);
  return handoff;
}

function openLatestThread(petId) {
  const candidates = tasks.filter(task => (!petId || task.petId === petId) && task.threadId);
  const latest = candidates[candidates.length - 1];
  openCodexThread(latest ? latest.threadId : null);
}

async function setDelegationMode(value, notify) {
  delegationOn = !!value;
  S.ui.delegationOn = delegationOn;
  await window.petOffice.setUi({ delegationOn });
  if (notify) bubble('supervisor', delegationOn ? '分工模式已开启' : '已切换为单 Agent 对话', 3200);
}

async function startNewConversation(petId, mode = false) {
  const project = currentProject();
  if (project) {
    const result = await window.petOffice.newChat({ projectId: project.id, petId });
    if (!result || !result.ok) {
      bubble(petId || 'supervisor', (result && result.error) || '无法新建会话', 6000);
      return;
    }
  }
  openComposer(petId, mode);
}

async function resetConversationContext(petId) {
  const project = currentProject();
  if (!project) return bubble(petId || 'supervisor', '请先选择项目', 4500);
  const pet = pets.get(petId) || pets.get('supervisor');
  const confirmed = await confirmAction(
    '重置上下文',
    '将断开 ' + pet.name + ' 在“' + project.name + '”中的当前会话。历史会话与项目文件会保留，下一条消息从空白上下文开始。',
    '重置上下文'
  );
  if (!confirmed) return;
  const result = await window.petOffice.resetChat({ projectId: project.id, petId: pet.id });
  if (!result || !result.ok) return bubble(pet.id, (result && result.error) || '无法重置上下文', 6500);
  projectSessionCache.delete(project.id);
  bubble(pet.id, '上下文已重置，历史会话仍可打开。', 5000);
  openComposer(pet.id, false);
}

function promptText(title, placeholder) {
  return new Promise(resolve => {
    const composer = $('#composer');
    clearTimeout(composerCloseTimer);
    composer.getAnimations().forEach(animation => animation.cancel());
    if (composerPetId && pets.get(composerPetId)) pets.get(composerPetId).el.classList.remove('composer-open');
    composerPetId = null;
    composer.className = 'ui dialog-composer';
    composer.removeAttribute('style');
    composer.innerHTML = '<header class="composer-head"><div><b>' + esc(title) + '</b></div><button class="close-btn" id="prompt-cancel">×</button></header>' +
      '<input class="prompt-input" id="prompt-input" type="text" placeholder="' + esc(placeholder) + '">' +
      '<div class="composer-foot"><button class="btn" id="prompt-back">取消</button><button class="btn primary" id="prompt-ok">确定</button></div>';
    composer.classList.remove('hidden');
    syncMouseCapture(composer);
    const input = composer.querySelector('#prompt-input');
    input.focus();
    const done = value => {
      composer.classList.add('hidden');
      syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y));
      resolve(value);
    };
    composer.querySelector('#prompt-ok').onclick = () => done(input.value.trim() || null);
    composer.querySelector('#prompt-back').onclick = () => done(null);
    composer.querySelector('#prompt-cancel').onclick = () => done(null);
    input.onkeydown = event => { if (event.key === 'Enter') done(input.value.trim() || null); };
  });
}

function confirmAction(title, message, confirmLabel = '确认') {
  return new Promise(resolve => {
    closeActivity(true);
    $('#panel').classList.add('hidden');
    openPanelFor = null;
    const composer = $('#composer');
    clearTimeout(composerCloseTimer);
    composer.getAnimations().forEach(animation => animation.cancel());
    if (composerPetId && pets.get(composerPetId)) pets.get(composerPetId).el.classList.remove('composer-open');
    composerPetId = null;
    composerAttachments = [];
    composer.className = 'ui dialog-composer';
    composer.removeAttribute('style');
    composer.innerHTML = '<header class="composer-head"><div><b>' + esc(title) + '</b></div><button class="close-btn" id="confirm-close">×</button></header>' +
      '<div class="confirm-dialog-copy">' + esc(message) + '</div>' +
      '<div class="composer-foot"><button class="btn" id="confirm-cancel">取消</button><button class="btn danger" id="confirm-ok">' + esc(confirmLabel) + '</button></div>';
    composer.classList.remove('hidden');
    syncMouseCapture(composer);
    const done = value => {
      composer.classList.add('hidden');
      syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y));
      resolve(value);
    };
    composer.querySelector('#confirm-close').onclick = () => done(false);
    composer.querySelector('#confirm-cancel').onclick = () => done(false);
    composer.querySelector('#confirm-ok').onclick = () => done(true);
  });
}

function openMenu(petId, x, y) {
  const pet = pets.get(petId);
  const menu = $('#ctxmenu');
  $('#panel').classList.add('hidden');
  closeActivity(true);
  openPanelFor = null;
  closeComposer(true);
  const activeTasks = tasks.filter(task => task.petId === petId && ['queued', 'running', 'waiting_input'].includes(task.status));
  let items;
  if (pet.role === 'supervisor') {
    items = [
      { label: '✎  继续当前对话', fn: () => openComposer('supervisor', false) },
      { label: '▣  截图提问', fn: () => window.petOffice.startCapture('supervisor') },
      { label: '✎  新建单 Agent 对话', fn: () => startNewConversation('supervisor', false) },
      { label: '↺  重置主管上下文', fn: () => resetConversationContext('supervisor') },
      { label: '⌘  新建分工任务', fn: () => openComposer('supervisor', true) },
      { label: '◉  查看任务动态', fn: () => openActivity() },
      ...activeTasks.filter(task => task.source === 'pet-chat').map(task => ({
        label: '取消对话 · ' + short(task.brief, 24), danger: true, fn: () => window.petOffice.cancelTask(task.id),
      })),
      { separator: true },
      ...S.pets.workers.map(worker => {
        const hidden = pets.get(worker.id).el.classList.contains('hidden-pet');
        return { label: (hidden ? '召唤  ' : '隐藏  ') + pets.get(worker.id).name, fn: () => hidden ? summonWorkers([worker.id], true) : hideWorker(worker.id, true) };
      }),
      { label: '召唤全部成员', fn: () => summonWorkers(['w1', 'w2', 'w3', 'w4'], true) },
      { separator: true },
      { label: '项目与团队设置…', fn: () => openPanel(petId, 'team') },
      { label: '隐藏到托盘（任务继续）', fn: () => window.petOffice.hideApp() },
      { separator: true },
      { label: '退出 Pet Office', danger: true, fn: () => window.petOffice.quit() },
    ];
  } else {
    items = [
      { label: '✎  继续当前对话', fn: () => openComposer(petId, false) },
      { label: '▣  截图提问', fn: () => window.petOffice.startCapture(petId) },
      { label: '＋  新建会话', fn: () => startNewConversation(petId, false) },
      { label: '↺  重置上下文', fn: () => resetConversationContext(petId) },
      { label: '打开最近会话', fn: () => openLatestThread(petId) },
      { label: '详情 / 切换模型', fn: () => openPanel(petId, 'overview') },
      { separator: true },
      { label: '隐藏该桌宠（任务继续）', fn: () => hideWorker(petId, true) },
    ];
    activeTasks.forEach(task => items.push({ label: '取消当前任务', danger: true, fn: () => window.petOffice.cancelTask(task.id) }));
  }
  menu.innerHTML = items.map((item, index) => item.separator
    ? '<div class="menu-separator"></div>'
    : '<button class="menu-item' + (item.danger ? ' danger' : '') + '" data-menu-index="' + index + '">' + esc(item.label) + '</button>').join('');
  menu.classList.remove('hidden');
  menu.style.left = Math.min(x, innerWidth - 230) + 'px';
  menu.style.top = Math.max(10, Math.min(y, innerHeight - menu.offsetHeight - 12)) + 'px';
  menu.querySelectorAll('[data-menu-index]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      menu.classList.add('hidden');
      items[Number(button.dataset.menuIndex)].fn();
      setTimeout(() => syncMouseCapture(document.elementFromPoint(lastPointer.x, lastPointer.y)), 0);
    };
  });
  syncMouseCapture(menu);
}

function composerWidth(mode) {
  return Math.min(mode ? 640 : 560, innerWidth - 24);
}

function quickButtonRect(pet) {
  const button = pet && pet.el ? pet.el.querySelector('[data-quick-chat]') : null;
  if (button) return button.getBoundingClientRect();
  const fallback = pet && pet.el ? pet.el.getBoundingClientRect() : { left: 0, top: 0, width: 34, height: 34, bottom: 34 };
  return { left: fallback.left, top: fallback.top, width: 34, height: 34, bottom: fallback.top + 34 };
}

function composerLayout(pet, mode, height) {
  const button = quickButtonRect(pet);
  const width = composerWidth(mode);
  let left = Math.max(12, Math.min(innerWidth - width - 12, Math.round(button.left + button.width / 2 - width / 2)));
  const top = Math.max(8, Math.min(Math.round(button.top), innerHeight - height - 12));
  // Near the bottom edge the expanded attachment stack has to move upward. In
  // that fallback, place it beside the pet so screenshots and warnings do not
  // cover the character itself.
  if (pet && pet.el && top < button.top - 2) {
    const petBox = pet.el.getBoundingClientRect();
    const leftCandidate = Math.round(petBox.left - width - 14);
    const rightCandidate = Math.round(petBox.right + 14);
    if (leftCandidate >= 12) left = leftCandidate;
    else if (rightCandidate + width <= innerWidth - 12) left = rightCandidate;
  }
  return { button, left, top, width, height };
}

function applyComposerRect(rect) {
  const composer = $('#composer');
  composer.style.left = Math.round(rect.left) + 'px';
  composer.style.top = Math.round(rect.top) + 'px';
  composer.style.width = Math.round(rect.width) + 'px';
  composer.style.height = Math.round(rect.height) + 'px';
}

function composerBox() {
  const box = $('#composer').getBoundingClientRect();
  return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
}

function sameRect(a, b) {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

function cancelComposerMotion() {
  clearTimeout(composerSurface.timer);
  composerSurface.timer = null;
  if (composerSurface.animation) {
    composerSurface.animation.onfinish = null;
    try { composerSurface.animation.cancel(); } catch {}
  }
  composerSurface.animation = null;
  const composer = $('#composer');
  if (composer) composer.getAnimations().forEach(animation => {
    animation.onfinish = null;
    try { animation.cancel(); } catch {}
  });
}

function animateComposerRect(from, to, duration = 230) {
  const composer = $('#composer');
  const epoch = ++composerSurface.epoch;
  cancelComposerMotion();
  // A resize can interrupt the initial pill-to-composer animation. Always settle
  // the visibility state first so cancelling an old animation never leaves every
  // control transparent behind the `morphing` class.
  composer.classList.remove('morphing');
  composer.classList.add('ready');
  if (sameRect(from, to) || motionReduced()) {
    applyComposerRect(to);
    return;
  }
  applyComposerRect(from);
  const animation = composer.animate([
    { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' },
    { left: to.left + 'px', top: to.top + 'px', width: to.width + 'px', height: to.height + 'px' },
  ], { duration, easing: 'cubic-bezier(.22,.86,.24,1)', fill: 'both' });
  composerSurface.animation = animation;
  const finish = () => {
    if (epoch !== composerSurface.epoch) return;
    animation.onfinish = null;
    try { animation.cancel(); } catch {}
    composerSurface.animation = null;
    clearTimeout(composerSurface.timer);
    composerSurface.timer = null;
    applyComposerRect(to);
  };
  animation.onfinish = finish;
  composerSurface.timer = setTimeout(finish, duration + 90);
}

function measureComposerHeight(width) {
  const composer = $('#composer');
  const previousWidth = composer.style.width;
  const previousHeight = composer.style.height;
  composer.style.width = width + 'px';
  composer.style.height = 'auto';
  const height = Math.round(composer.getBoundingClientRect().height) || 56;
  composer.style.width = previousWidth;
  composer.style.height = previousHeight;
  return height;
}

function composerStackHtml(target, mode, draft) {
  const roster = ['w1', 'w2', 'w3', 'w4'].map(id => pets.get(id)).filter(Boolean);
  const project = currentProject();
  const defaults = mode ? new Set(target.role === 'worker' ? [target.id, 'w1', 'w2'] : ['w1', 'w2']) : new Set([target.id]);
  return '<div class="composer-stack">' +
    '<section class="delegation-options' + (mode ? '' : ' hidden') + '" id="c-delegation-options"><div class="inline-heading"><span><b>参与 Agent</b><small>由 ' + esc(pets.get('supervisor').name) + ' 主管规划、检查和终审</small></span><div class="inline-actions"><button class="text-btn" id="c-recommend">智能推荐</button><button class="text-btn" id="c-open-codex">在 Codex 中打开</button></div></div><div class="recommendation-note hidden" id="c-recommendation-note"></div><div class="agent-grid">' + roster.map(pet =>
      '<label class="agent-choice"><input type="checkbox" data-pet="' + pet.id + '"' + (defaults.has(pet.id) ? ' checked' : '') + '><span class="agent-chip"><i class="member-color c-' + pet.id + '"></i><b>' + esc(pet.name) + '</b><small>' + esc(modelName(pet.model)) + '</small></span><select data-model="' + pet.id + '">' + modelOptions(pet.model) + '</select><span class="agent-capabilities" data-agent-capabilities="' + pet.id + '">' + capabilityBadges(pet.model, true) + '</span></label>'
    ).join('') + '</div><input class="hidden" type="checkbox" id="c-planner" checked><div class="planner-row"><span>推荐只预选参与者；你仍需确认 Agent、模型与主管计划</span></div></section>' +
    '<div class="composer-project-line' + (mode ? '' : ' hidden') + '" id="c-project-line"><span>共享工作区</span><button class="project-trigger" id="c-project-trigger">' + esc(project ? project.name : '选择或新建项目') + '⌄</button><span class="workspace-note">结果与记忆由所选 Agent 共享</span></div>' +
    '<div class="composer-files hidden" id="c-files"></div>' +
    '<div class="attachment-note hidden" id="c-attachment-note"></div>' +
    '<div class="composer-input-row"><button class="round-btn' + (!mode && project ? ' hidden' : '') + '" id="c-project-button" title="选择项目">＋</button><textarea id="c-text" rows="1" placeholder="发送给 ' + esc(target.name) + ' · ' + esc(modelName(target.model)) + '；输入 /截图 可选区提问">' + esc(draft) + '</textarea>' +
    '<label class="delegate-switch" title="分工模式"><span>分工</span>' + switchHtml('c-delegation', mode) + '</label><button class="send-btn" id="c-send" title="发送">↑</button><button class="inline-close" id="c-close" title="收起">×</button></div></div>' +
    '<div class="project-popover hidden" id="c-project-popover">' + projectPickerHtml() + '</div>';
}

function openComposer(targetPetId = 'supervisor', requestedDelegation = delegationOn, draft = '') {
  const composer = $('#composer');
  const motionEpoch = ++composerSurface.epoch;
  cancelComposerMotion();
  clearTimeout(composerCloseTimer);
  $('#panel').classList.add('hidden');
  closeActivity(true);
  $('#ctxmenu').classList.add('hidden');
  hideLiveTaskCard();
  openPanelFor = null;
  const target = pets.get(targetPetId) || pets.get('supervisor');
  const mode = !!requestedDelegation;
  const width = composerWidth(mode);
  const reusable = !composer.classList.contains('hidden') && composer.classList.contains('pet-composer') && composerPetId === target.id;
  const before = reusable ? composerBox() : null;
  if (!reusable) composerAttachments = [];

  petMapValues().forEach(pet => { if (pet.id !== target.id) pet.el.classList.remove('composer-open'); });
  composerPetId = target.id;
  target.el.classList.add('composer-open');
  composer.className = 'ui pet-composer' + (reusable ? '' : ' morphing');
  composer.setAttribute?.('role', 'dialog');
  composer.setAttribute?.('aria-label', mode ? '分工任务输入' : '对话输入');
  composer.removeAttribute('style');
  composer.innerHTML = composerStackHtml(target, mode, draft);
  composer.classList.remove('hidden');
  syncMouseCapture(composer);
  composer.querySelectorAll('#c-delegation-options, #c-project-line').forEach(element => element.classList.add('hidden'));
  const settledHeight = measureComposerHeight(width);
  const layout = composerLayout(target, mode, settledHeight);
  composer.classList.toggle('morphing', !reusable);

  if (reusable) {
    applyComposerRect(before);
    composer.classList.add('ready');
    resizeComposer(target, mode, false);
  } else {
    const button = layout.button;
    applyComposerRect({ left: button.left, top: button.top, width: button.width, height: button.height });
    if (motionReduced()) {
      composer.classList.remove('morphing');
      composer.classList.add('ready');
      applyComposerRect(layout);
      if (mode) revealDelegation(target, mode);
      bindComposer(target.id, mode);
      composer.querySelector('#c-text').focus({ preventScroll: true });
      return;
    }
    const grow = composer.animate([
      { left: button.left + 'px', top: button.top + 'px', width: button.width + 'px', height: button.height + 'px', borderRadius: '9999px' },
      { left: layout.left + 'px', top: layout.top + 'px', width: layout.width + 'px', height: layout.height + 'px', borderRadius: '18px' },
    ], { duration: 250, easing: 'cubic-bezier(.22,.86,.24,1)', fill: 'both' });
    composerSurface.animation = grow;
    const finishGrow = () => {
      if (motionEpoch !== composerSurface.epoch) return;
      grow.onfinish = null;
      try { grow.cancel(); } catch {}
      composerSurface.animation = null;
      clearTimeout(composerSurface.timer);
      composerSurface.timer = null;
      composer.classList.remove('morphing');
      composer.classList.add('ready');
      applyComposerRect(layout);
      if (mode) revealDelegation(target, mode);
    };
    grow.onfinish = finishGrow;
    composerSurface.timer = setTimeout(finishGrow, 340);
  }
  bindComposer(target.id, mode);
  composer.querySelector('#c-text').focus({ preventScroll: true });
}

function revealDelegation(target, mode) {
  const composer = $('#composer');
  const from = composerBox();
  composer.querySelectorAll('#c-delegation-options, #c-project-line').forEach(element => element.classList.remove('hidden'));
  const height = measureComposerHeight(composerWidth(mode));
  animateComposerRect(from, composerLayout(target, mode, height), 230);
}

function resizeComposer(pet, mode, animate = true) {
  const composer = $('#composer');
  if (!composer.classList.contains('pet-composer')) return;
  // Resizing can be the event that interrupts the initial open animation (for
  // example when automatic Agent recommendation returns immediately). Make the
  // requested mode authoritative instead of relying on the cancelled opener to
  // reveal these sections later.
  composer.querySelectorAll('#c-delegation-options, #c-project-line').forEach(element => element.classList.toggle('hidden', !mode));
  if (!animate) {
    composer.getAnimations().forEach(animation => animation.cancel());
    composer.classList.remove('morphing');
    composer.classList.add('ready');
  }
  const width = composerWidth(mode);
  const height = measureComposerHeight(width);
  const to = composerLayout(pet, mode, height);
  if (!animate) {
    applyComposerRect(to);
    return;
  }
  animateComposerRect(composerBox(), to, 220);
}

function conversationPreview(petId) {
  const recent = tasks.filter(task => task.petId === petId).slice(-3).reverse();
  if (!recent.length) return '<span>还没有历史任务。你可以直接输入第一条消息。</span>';
  return recent.map(task => '<div><b>' + esc(STATUS_TEXT[statusForTask(task.status)] || '') + '</b><span>' + esc(short(task.brief, 56)) + '</span></div>').join('');
}

function projectPickerHtml(query = '') {
  const normalized = query.trim().toLowerCase();
  const projects = (S.projects || []).filter(project => !project.archived).filter(project => !normalized || project.name.toLowerCase().includes(normalized) || project.path.toLowerCase().includes(normalized));
  return '<div class="new-project-row"><input id="c-new-project" type="text" placeholder="新建项目"><button class="btn primary compact" id="c-create-project">创建</button></div>' +
    '<input class="project-search" id="c-project-search" type="search" value="' + esc(query) + '" placeholder="搜索已有项目">' +
    '<div class="project-list">' + (projects.length ? projects.map(project => '<button data-pick-project="' + esc(project.id) + '" class="project-option' + (project.id === S.activeProjectId ? ' active' : '') + '"><b>' + esc(project.name) + '</b><small>' + esc(project.path) + '</small></button>').join('') : '<div class="empty-state">没有匹配项目</div>') + '</div>' +
    '<button class="text-btn add-folder" id="c-add-folder">＋ 添加现有文件夹</button>';
}

function bindComposer(targetPetId, initialMode) {
  const composer = $('#composer');
  let mode = initialMode;
  composer.querySelector('#c-close').onclick = () => closeComposer();
  composer.querySelector('#c-delegation').onchange = async event => {
    mode = event.target.checked;
    composer.querySelector('#c-delegation-options').classList.toggle('hidden', !mode);
    composer.querySelector('#c-project-line').classList.toggle('hidden', !mode);
    composer.querySelector('#c-project-button').classList.toggle('hidden', !mode && !!currentProject());
    await setDelegationMode(mode, false);
    resizeComposer(pets.get(targetPetId), mode);
    if (mode && composer.querySelector('#c-text').value.trim().length >= 12) setTimeout(() => applyAgentRecommendation(true), 120);
  };
  composer.querySelector('#c-project-button').onclick = () => toggleProjectPicker(true);
  composer.querySelector('#c-project-trigger').onclick = () => toggleProjectPicker();
  bindComposerProjectPicker(targetPetId, () => mode);
  composer.querySelector('#c-open-codex').onclick = () => openLatestThread(null);
  const recommend = composer.querySelector('#c-recommend');
  if (recommend) recommend.onclick = () => applyAgentRecommendation();
  composer.querySelectorAll('[data-pet]').forEach(input => { input.onchange = () => renderComposerFiles(); });
  composer.querySelectorAll('[data-model]').forEach(select => {
    select.onchange = () => {
      const holder = composer.querySelector('[data-agent-capabilities="' + select.dataset.model + '"]');
      if (holder) holder.innerHTML = capabilityBadges(select.value || null, true);
      const chip = select.closest('.agent-choice').querySelector('.agent-chip small');
      if (chip) chip.textContent = modelName(select.value || null);
      renderComposerFiles();
    };
  });
  composer.querySelector('#c-send').onclick = () => submitComposer(targetPetId, mode);
  composer.querySelector('#c-text').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const command = composer.querySelector('#c-text').value.trim().toLowerCase();
      if (command === '/截图' || command === '/shot' || command === '/screenshot') {
        composer.querySelector('#c-text').value = '';
        window.petOffice.startCapture(targetPetId);
        return;
      }
      submitComposer(targetPetId, mode);
    }
  };
  renderComposerFiles();
  if (initialMode && composer.querySelector('#c-text').value.trim().length >= 12) setTimeout(() => applyAgentRecommendation(true), 120);
}

async function applyAgentRecommendation(automatic = false) {
  const composer = $('#composer');
  const text = composer.querySelector('#c-text') && composer.querySelector('#c-text').value.trim();
  const note = composer.querySelector('#c-recommendation-note');
  if (!text) {
    if (!automatic) bubble('supervisor', '先输入任务内容，才能推荐参与 Agent。', 3800);
    return;
  }
  const button = composer.querySelector('#c-recommend');
  if (button) { button.disabled = true; button.textContent = '分析中…'; }
  const result = await window.petOffice.recommendAgents({ taskText: text, projectId: S.activeProjectId });
  if (button) { button.disabled = false; button.textContent = '重新推荐'; }
  if (!result || !Array.isArray(result.selected)) return;
  const selected = new Map(result.selected.map(item => [item.petId, item]));
  composer.querySelectorAll('[data-pet]').forEach(input => { input.checked = selected.has(input.dataset.pet); });
  for (const item of result.selected) {
    const select = composer.querySelector('[data-model="' + item.petId + '"]');
    if (select && item.model != null && [...select.options].some(option => option.value === item.model)) select.value = item.model;
    if (select && typeof select.onchange === 'function') select.onchange();
  }
  if (note) {
    note.classList.remove('hidden');
    note.innerHTML = '<b>推荐完成，等待你确认</b><span>' + result.selected.map(item => esc((pets.get(item.petId) && pets.get(item.petId).name) || item.petId) + ' · ' + esc(item.reason)).join('；') + '</span>';
  }
  resizeComposer(pets.get(composerPetId) || pets.get('supervisor'), true);
}

function humanSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1048576) return (value / 1048576).toFixed(1) + 'MB';
  if (value >= 1024) return Math.round(value / 1024) + 'KB';
  return value + 'B';
}

function composerVisionWarning() {
  if (!composerAttachments.some(item => item.source === 'capture' || item.kind === '图片')) return '';
  const composer = $('#composer');
  const unsupported = [];
  const delegation = composer && composer.querySelector('#c-delegation');
  if (delegation && delegation.checked) {
    composer.querySelectorAll('[data-pet]:checked').forEach(input => {
      const select = composer.querySelector('[data-model="' + input.dataset.pet + '"]');
      const slug = select && select.value || null;
      const record = modelRecord(slug);
      if (providerOf(slug) !== 'openai' && !(record && record.capabilities && record.capabilities.vision)) {
        unsupported.push((pets.get(input.dataset.pet) || {}).name || input.dataset.pet);
      }
    });
  } else {
    const pet = pets.get(composerPetId) || pets.get('supervisor');
    const record = modelRecord(pet && pet.model);
    if (pet && providerOf(pet.model) !== 'openai' && !(record && record.capabilities && record.capabilities.vision)) unsupported.push(pet.name);
  }
  return unsupported.length ? ('⚠ ' + unsupported.join('、') + ' 的当前模型未标注视觉能力，建议先切换视觉模型。') : '';
}

function renderComposerFiles() {
  const box = $('#c-files');
  if (!box) return;
  const note = $('#c-attachment-note');
  const wasHidden = box.classList.contains('hidden');
  const resizeForAttachments = () => requestAnimationFrame(() => {
    const target = composerPetId && pets.get(composerPetId);
    const delegation = $('#c-delegation');
    if (target && !$('#composer').classList.contains('hidden')) resizeComposer(target, !!(delegation && delegation.checked), false);
  });
  if (!composerAttachments.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    if (note) { note.classList.add('hidden'); note.innerHTML = ''; }
    if (!wasHidden) resizeForAttachments();
    return;
  }
  box.classList.remove('hidden');
  box.setAttribute('role', 'list');
  box.setAttribute('aria-label', '待发送附件');
  box.innerHTML = composerAttachments.map((file, index) => {
    const isLink = file.type === 'link';
    const isCapture = file.source === 'capture';
    const icon = isLink
      ? '<button type="button" class="attachment-icon open-attachment" data-link-open="' + index + '" aria-label="在浏览器打开 ' + esc(file.name) + '">↗</button>'
      : (isCapture && file.previewDataUrl
        ? '<span class="attachment-icon attachment-preview"><img src="' + esc(file.previewDataUrl) + '" alt=""></span>'
        : '<span class="attachment-icon">' + esc(String(file.kind || '文件').slice(0, 1)) + '</span>');
    const meta = isLink ? (file.domain || '网页链接') : ((file.kind || '文件') + ' · ' + humanSize(file.size));
    return '<article class="file-chip attachment-card' + (isLink ? ' link' : '') + (isCapture ? ' screenshot' : '') + '" role="listitem" title="' + esc(file.url || file.relPath || file.name) + '">' + icon + '<span><b>' + esc(file.name) + '</b><small>' + esc(meta) + '</small></span><button class="attachment-remove" type="button" data-file-remove="' + index + '" aria-label="移除 ' + esc(file.name) + '">×</button></article>';
  }).join('');
  box.querySelectorAll('[data-link-open]').forEach(button => {
    button.onclick = () => window.petOffice.openExternal(composerAttachments[Number(button.dataset.linkOpen)].url);
  });
  box.querySelectorAll('[data-file-remove]').forEach(button => {
    button.onclick = () => {
      composerAttachments.splice(Number(button.dataset.fileRemove), 1);
      renderComposerFiles();
    };
  });
  if (note) {
    const hasCapture = composerAttachments.some(item => item.source === 'capture');
    const hasLink = composerAttachments.some(item => item.type === 'link');
    const warning = composerVisionWarning();
    note.classList.toggle('hidden', !hasCapture && !hasLink && !warning);
    note.innerHTML = (hasCapture ? '<div class="quick-prompts"><span>快速提问</span>' + ['解释这部分', '总结重点', '检查错误', '下一步怎么做'].map(text => '<button type="button" data-quick-prompt="' + esc(text) + '">' + esc(text) + '</button>').join('') + '</div>' : '') + (hasLink ? '<div class="link-hint">需要登录的 Canvas 页面可能无法由模型直接读取；遇到权限页时请同时附截图或下载后的文件。</div>' : '') + (warning ? '<div class="vision-warning">' + esc(warning) + '</div>' : '');
    note.querySelectorAll('[data-quick-prompt]').forEach(button => {
      button.onclick = () => {
        const input = $('#c-text');
        input.value = button.dataset.quickPrompt;
        input.focus({ preventScroll: true });
      };
    });
  }
  resizeForAttachments();
}

function attachmentPromptBlock(attachments = composerAttachments) {
  if (!attachments.length) return '';
  const lines = attachments.map(file => file.type === 'link'
    ? '- 网页链接：' + file.name + ' — ' + file.url
    : '- ' + (file.relPath || file.name) + '（' + (file.kind || '文件') + '，' + humanSize(file.size) + '）');
  return '\n\n附件与参考链接：\n' + lines.join('\n');
}

async function prepareComposerAttachments(projectId, attachments = composerAttachments.slice()) {
  const prepared = [];
  for (const file of attachments) {
    if (file.type === 'link' || file.projectId === projectId) { prepared.push(file); continue; }
    if (!file.path) throw new Error('附件缺少源文件路径，请重新拖入：' + file.name);
    const result = await window.petOffice.ingestFiles([file.path], projectId);
    if (!result || !result.ok || !result.files || !result.files.length) throw new Error((result && result.error) || '附件复制失败');
    const replacement = { ...file, ...result.files[0], projectId };
    prepared.push(replacement);
    // Preserve the completed copy if a later attachment fails, so retrying does
    // not duplicate files. Never replace attachments added to a newer composer.
    composerAttachments = composerAttachments.map(item => item === file ? replacement : item);
  }
  return prepared;
}

async function ensureQuickProject() {
  if (currentProject()) return currentProject();
  const name = '快速提问-' + new Date().toISOString().slice(0, 10);
  let project = (S.projects || []).find(item => !item.archived && item.name === name);
  if (project) await window.petOffice.selectProject(project.id);
  else project = await window.petOffice.createProject(name);
  if (project) {
    S.projects = [...(S.projects || []).filter(item => item.id !== project.id), project];
    S.activeProjectId = project.id;
  }
  return project;
}

async function receiveDroppedLinks(petId, links) {
  const target = pets.get(petId) || pets.get('supervisor');
  if (!target || !Array.isArray(links) || !links.length) return null;
  const project = await ensureQuickProject();
  if (!project) {
    bubble(target.id, '无法创建快速提问工作区', 7000, 'attention');
    return null;
  }
  const alreadyOpen = composerPetId === target.id && !$('#composer').classList.contains('hidden');
  if (!alreadyOpen) openComposer(target.id, false);
  const known = new Set(composerAttachments.filter(item => item.type === 'link').map(item => item.url));
  for (const link of links) if (!known.has(link.url)) { composerAttachments.push(link); known.add(link.url); }
  renderComposerFiles();
  const input = $('#c-text');
  if (input) {
    input.placeholder = '针对这些网页链接，你想问什么？';
    input.focus({ preventScroll: true });
  }
  bubble(target.id, '已接收 ' + links.length + ' 个网页链接', 6500, 'detail');
  return { links, project };
}

async function receiveDroppedPaths(petId, paths) {
  const target = pets.get(petId) || pets.get('supervisor');
  if (!target || !paths || !paths.length) return null;
  const result = await window.petOffice.ingestFiles(paths);
  if (!result || !result.ok) {
    bubble(target.id, (result && result.error) || '文件接收失败', 8000);
    return null;
  }
  if (Array.isArray(result.skipped) && result.skipped.length) {
    bubble(target.id, '有 ' + result.skipped.length + ' 个文件被跳过：' + (result.skipped[0].reason || ''), 7000);
  }
  await refreshState();
  const alreadyOpen = composerPetId === target.id && !$('#composer').classList.contains('hidden');
  if (!alreadyOpen) openComposer(target.id, delegationOn);
  composerAttachments = composerAttachments.concat(result.files);
  renderComposerFiles();
  bubble(target.id, '已接收 ' + result.files.length + ' 个文件 → ' + ((result.project && result.project.name) || '项目工作区'), 8000);
  return result;
}

function toggleProjectPicker(forceOpen) {
  const popover = $('#c-project-popover');
  const open = typeof forceOpen === 'boolean' ? forceOpen : popover.classList.contains('hidden');
  popover.classList.toggle('hidden', !open);
  if (open) setTimeout(() => popover.querySelector('#c-new-project').focus(), 0);
}

function bindComposerProjectPicker(targetPetId, modeGetter) {
  const popover = $('#c-project-popover');
  const rebind = query => {
    popover.innerHTML = projectPickerHtml(query);
    bindComposerProjectPicker(targetPetId, modeGetter);
    const search = popover.querySelector('#c-project-search');
    search.focus();
    search.setSelectionRange(search.value.length, search.value.length);
  };
  popover.querySelector('#c-project-search').oninput = event => rebind(event.target.value);
  popover.querySelector('#c-create-project').onclick = async () => {
    if (composerSubmitting) return;
    const input = popover.querySelector('#c-new-project');
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    const draft = $('#c-text').value;
    const project = await window.petOffice.createProject(name);
    if (!project) return;
    S.projects = [...(S.projects || []).filter(item => item.id !== project.id), project];
    S.activeProjectId = project.id;
    openComposer(targetPetId, modeGetter(), draft);
  };
  popover.querySelector('#c-new-project').onkeydown = event => {
    if (event.key === 'Enter') popover.querySelector('#c-create-project').click();
  };
  popover.querySelectorAll('[data-pick-project]').forEach(button => {
    button.onclick = async () => {
      if (composerSubmitting) return;
      if (!await window.petOffice.selectProject(button.dataset.pickProject)) return;
      S.activeProjectId = button.dataset.pickProject;
      $('#c-project-trigger').textContent = currentProject().name + '⌄';
      toggleProjectPicker(false);
      renderComposerFiles();
    };
  });
  popover.querySelector('#c-add-folder').onclick = async () => {
    if (composerSubmitting) return;
    const draft = $('#c-text').value;
    const project = await window.petOffice.addProject();
    if (!project) return;
    S.projects = [...(S.projects || []).filter(item => item.id !== project.id), project];
    S.activeProjectId = project.id;
    openComposer(targetPetId, modeGetter(), draft);
  };
}

async function submitComposer(targetPetId, mode) {
  if (composerSubmitting) return;
  const composer = $('#composer');
  const text = composer.querySelector('#c-text').value.trim();
  if (!text) {
    composer.querySelector('#c-text').focus();
    return;
  }
  if (!currentProject()) {
    toggleProjectPicker(true);
    bubble('supervisor', '请先选择或新建项目工作区', 4000);
    return;
  }

  let participants;
  let usePlanner = false;
  if (mode) {
    participants = [...composer.querySelectorAll('[data-pet]')].filter(input => input.checked).map(input => {
      const pet = pets.get(input.dataset.pet);
      const model = composer.querySelector('[data-model="' + pet.id + '"]').value || null;
      return { petId: pet.id, name: pet.name, model, fallbackModel: null, use: true };
    });
    if (!participants.length) {
      bubble('supervisor', '请至少选择一个 Agent', 3500);
      return;
    }
    usePlanner = true;
  } else {
    const pet = pets.get(targetPetId);
    participants = [{ petId: pet.id, name: pet.name, model: pet.model, use: true }];
  }

  const projectId = S.activeProjectId;
  const epoch = composerSurface.epoch;
  composerSubmitting = true;
  const send = composer.querySelector('#c-send');
  send.disabled = true;
  send.textContent = '…';
  try {
    await Promise.all(participants.map(async participant => {
      const pet = pets.get(participant.petId);
      if (pet.model !== participant.model) {
        pet.model = participant.model;
        await window.petOffice.setModel(pet.id, pet.model);
      }
    }));
    if (epoch !== composerSurface.epoch) return;
    if (mode) {
      showConfirm(text, participants, usePlanner, true);
      return;
    }

    const attachments = await prepareComposerAttachments(projectId);
    if (epoch !== composerSurface.epoch) return;
    const result = await window.petOffice.startChat({
      taskText: text + attachmentPromptBlock(attachments),
      projectId,
      petId: participants[0].petId,
      model: participants[0].model,
    });
    if (!result || !result.ok) {
      send.disabled = false;
      send.textContent = '↑';
      bubble('supervisor', (result && result.error) || '发送失败', 6000);
      return;
    }
    if (epoch === composerSurface.epoch) closeComposer(true);
    bubble(participants[0].petId, '收到，开始处理。', 5000);
  } catch (error) {
    bubble(targetPetId, error.message || '发送失败，请重试', 6000, 'attention');
  } finally {
    composerSubmitting = false;
    send.disabled = false;
    send.textContent = '↑';
  }
}

function showConfirm(taskText, participants, usePlanner, mode) {
  const composer = $('#composer');
  const project = currentProject();
  const pet = pets.get(participants[0].petId);
  const width = composerWidth(mode);
  const current = composerBox();
  composer.getAnimations().forEach(animation => animation.cancel());
  composer.className = 'ui pet-composer confirming ready';
  composer.innerHTML = '<div class="composer-stack confirm-stack">' +
    '<div class="inline-heading"><span><b>确认开始</b><small>' + (mode ? '多 Agent 分工' : '单 Agent 对话') + '</small></span><button class="inline-close" id="c-close" title="收起">×</button></div>' +
    '<div class="confirm-card"><label>项目</label><b>' + esc(project ? project.name : '(未选择)') + '</b><small>' + esc(project ? project.path : '') + '</small></div>' +
    '<div class="confirm-card"><label>任务</label><p>' + esc(short(taskText, 220)) + '</p></div>' +
    (composerAttachments.length ? '<div class="confirm-card"><label>附件</label><div class="confirm-agents">' + composerAttachments.map(file => '<span>' + esc(file.name) + '<small>' + esc(file.kind || '文件') + ' · ' + esc(humanSize(file.size)) + '</small></span>').join('') + '</div></div>' : '') +
    '<div class="confirm-card"><label>参与者</label><div class="confirm-agents">' + participants.map(item => '<span>' + esc(pets.get(item.petId).name) + '<small>' + esc(modelName(item.model)) + '</small></span>').join('') + '</div></div>' +
    '<div class="approval-note">' + (mode ? '并行任务受 workspace-write 沙箱限制。' : '将在 Codex 真实会话中执行；点击“在 Codex 中打开”可继续查看。') + ' 桌宠不会自动批准提权操作。</div>' +
    '<div class="composer-foot"><button class="btn" id="c-back">返回</button><button class="btn primary" id="c-go">确认开始</button></div></div>';
  const height = measureComposerHeight(width);
  animateComposerRect(current, composerLayout(pet, mode, height), 220);
  const closeButton = composer.querySelector('#c-close');
  if (closeButton) closeButton.onclick = () => closeComposer();
  composer.querySelector('#c-back').onclick = () => openComposer(participants[0].petId, mode, taskText);
  composer.querySelector('#c-go').onclick = async () => {
    if (composerSubmitting) return;
    composerSubmitting = true;
    const epoch = composerSurface.epoch;
    const go = composer.querySelector('#c-go');
    go.disabled = true;
    go.textContent = '正在启动…';
    try {
      const attachments = await prepareComposerAttachments(project.id);
      if (epoch !== composerSurface.epoch) return;
      const composed = taskText + attachmentPromptBlock(attachments);
      const result = mode
        ? await window.petOffice.createMissionDraft({ taskText: composed, projectId: project.id, participants })
        : await window.petOffice.startChat({
          taskText: composed,
          projectId: project.id,
          petId: participants[0].petId,
          model: participants[0].model,
        });
      if (epoch !== composerSurface.epoch) return;
      if (!result || !result.ok) {
        go.disabled = false;
        go.textContent = '确认开始';
        bubble('supervisor', (result && result.error) || '启动失败', 6000);
        return;
      }
      if (mode) {
        missions = [result.mission, ...missions.filter(item => item.id !== result.mission.id)];
        showMissionPlan(result.mission, taskText, participants);
        bubble('supervisor', '依赖计划已生成，请确认后开工。', 7000);
        return;
      }
      closeComposer(true);
      summonWorkers(participants.filter(item => item.petId !== 'supervisor').map(item => item.petId), false);
      bubble('supervisor', mode ? '收到，开始分工！' : '收到，开始处理。', 5000);
    } catch (error) {
      bubble('supervisor', error.message || '启动失败，请重试', 6000, 'attention');
    } finally {
      composerSubmitting = false;
      go.disabled = false;
      go.textContent = '确认开始';
    }
  };
}

function showMissionPlan(mission, originalText, participants) {
  const composer = $('#composer');
  const boss = pets.get('supervisor');
  const width = Math.min(620, Math.max(430, composerWidth(true) + 120));
  const current = composerBox();
  const waves = new Map();
  for (const task of mission.tasks || []) {
    if (!waves.has(task.wave)) waves.set(task.wave, []);
    waves.get(task.wave).push(task);
  }
  const waveHtml = [...waves.entries()].sort((a, b) => a[0] - b[0]).map(([wave, items]) =>
    '<section class="plan-wave"><header><b>阶段 ' + (Number(wave) + 1) + '</b><small>' + items.length + ' 个任务</small></header>' + items.map(task =>
      '<article class="plan-node"><span class="member-color c-' + esc(task.assigneePetId) + '"></span><div><b>' + esc(task.title) + '</b><p>' + esc(short(task.brief, 180)) + '</p><small>' + esc(task.assigneeName || task.assigneePetId) + ' · ' + esc(modelName(task.model)) + ' · ' + esc(task.mode) + (task.dependsOn.length ? ' · 依赖 ' + esc(task.dependsOn.join(', ')) : '') + '</small></div></article>'
    ).join('') + '</section>'
  ).join('');
  composer.getAnimations().forEach(animation => animation.cancel());
  composer.className = 'ui pet-composer mission-preview ready';
  composer.innerHTML = '<div class="composer-stack mission-plan-stack"><div class="inline-heading"><span><b>主管计划</b><small>确认后才会创建隔离工作区并启动 Agent</small></span><button class="inline-close" id="c-close" title="收起">×</button></div><div class="mission-plan-scroll">' + waveHtml + '</div><div class="approval-note">每个依赖波次结束后由主管检查；失败节点最多自动重派一次。冲突和高风险回写会暂停等待你。</div><div class="composer-foot"><button class="btn" id="c-back">返回修改</button><button class="btn" id="c-replan">重新规划</button><button class="btn primary" id="c-confirm-mission">确认并开工</button></div></div>';
  const height = Math.min(Math.round(innerHeight * .72), measureComposerHeight(width));
  animateComposerRect(current, composerLayout(boss, true, height), 220);
  composer.querySelector('#c-close').onclick = () => closeComposer();
  composer.querySelector('#c-back').onclick = () => openComposer('supervisor', true, originalText);
  composer.querySelector('#c-replan').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = '规划中…';
    const result = await window.petOffice.regenerateMission(mission.id);
    if (!result || !result.ok) { button.disabled = false; button.textContent = '重新规划'; bubble('supervisor', (result && result.error) || '重新规划失败', 7000); return; }
    missions = [result.mission, ...missions.filter(item => item.id !== result.mission.id)];
    showMissionPlan(result.mission, originalText, participants);
  };
  composer.querySelector('#c-confirm-mission').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = '启动中…';
    const result = await window.petOffice.confirmMission(mission.id);
    if (!result || !result.ok) { button.disabled = false; button.textContent = '确认并开工'; bubble('supervisor', (result && result.error) || '启动失败', 7000); return; }
    closeComposer(true);
    summonWorkers(participants.map(item => item.petId), false);
    bubble('supervisor', '计划已确认，团队开始执行。', 6000);
  };
}
