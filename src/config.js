'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.pet-office');
const DIRS = {
  app: APP_DIR,
  logs: path.join(APP_DIR, 'logs'),
  bin: path.join(APP_DIR, 'bin'),
  bridge: path.join(APP_DIR, 'bridge'),
  toPets: path.join(APP_DIR, 'bridge', 'to-pets'),
  fromPets: path.join(APP_DIR, 'bridge', 'from-pets'),
  processed: path.join(APP_DIR, 'bridge', 'to-pets', 'processed'),
  runtime: path.join(APP_DIR, 'runtime'),
  ruflo: path.join(APP_DIR, 'ruflo'),
  rufloRuntime: path.join(APP_DIR, 'ruflo', 'runtime'),
  rufloProjects: path.join(APP_DIR, 'ruflo', 'projects'),
  rufloLogs: path.join(APP_DIR, 'ruflo', 'logs'),
  crashes: path.join(APP_DIR, 'crashes'),
  captures: path.join(APP_DIR, 'captures'),
  projectsRoot: path.join(HOME, 'Documents', 'PetOffice', 'projects'),
  petdexPets: path.join(HOME, '.petdex', 'pets'),
};
const CODEX_HOME = path.join(HOME, '.codex');
const CATALOG_FILE = path.join(CODEX_HOME, 'opencodex-catalog.json');
const OPENCODEX_HOME = path.join(HOME, '.opencodex');
const ADMIN_TOKEN_FILE = path.join(OPENCODEX_HOME, 'admin-api-token');
const PROXY_BASE = 'http://127.0.0.1:10100';
const STATE_FILE = path.join(APP_DIR, 'state.json');
const STATE_BACKUP_FILE = path.join(APP_DIR, 'state.backup.json');
const STATE_TEMP_FILE = path.join(APP_DIR, 'state.next.json');
const LOG_FILE = path.join(DIRS.logs, 'app.log');
const LOG_BACKUP_FILE = path.join(DIRS.logs, 'app.previous.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const STATE_SCHEMA_VERSION = 6;

let pendingState = null;
let saveTimer = null;

const DEFAULT_STATE = {
  schemaVersion: STATE_SCHEMA_VERSION,
  projects: [],
  history: [],
  activeProjectId: null,
  settings: {
    autostart: false,
    maxParallel: 5,
    workerSlots: 4,
    quotaPollSec: 60,
    compactMode: false,
    petScale: 1,
    reducedMotion: false,
    toggleShortcut: 'Control+Alt+P',
    captureShortcut: 'Control+Alt+S',
    displayMode: 'cursor',
    fullscreenBehavior: 'corner',
    notificationMode: 'standard',
    themeMode: 'warm',
    fontScale: 1,
    fontFamily: 'system',
    autoCheckUpdates: true,
    rufloDelegation: true,
  },
  ui: {
    delegationOn: false,
    hiddenPets: ['w1', 'w2', 'w3', 'w4'],
    petPositions: {},
    taskProjectFilter: 'all',
    pinnedLiveTaskKey: null,
  },
  pets: {
    supervisor: { name: 'Michael', model: null, modelMode: 'auto', skin: null },
    workers: [
      { id: 'w1', name: '小蓝', model: null, modelMode: 'auto', skin: null },
      { id: 'w2', name: '小绿', model: null, modelMode: 'auto', skin: null },
      { id: 'w3', name: '小橙', model: null, modelMode: 'auto', skin: null },
      { id: 'w4', name: '小紫', model: null, modelMode: 'auto', skin: null },
    ],
  },
  caps: {},
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function hydrateState(parsed) {
    const parsedPets = parsed.pets || {};
    const parsedWorkers = Array.isArray(parsedPets.workers) ? parsedPets.workers : [];
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      schemaVersion: STATE_SCHEMA_VERSION,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      pets: {
        supervisor: { ...DEFAULT_STATE.pets.supervisor, ...(parsedPets.supervisor || {}) },
        workers: DEFAULT_STATE.pets.workers.map(worker => ({
          ...worker,
          ...(parsedWorkers.find(item => item.id === worker.id) || {}),
        })),
      },
      ui: { ...DEFAULT_STATE.ui, ...(parsed.ui || {}) },
      projects: Array.isArray(parsed.projects) ? parsed.projects.map(project => {
        const now = Date.now();
        return {
          ...project,
          archived: !!project.archived,
          threadIds: Array.isArray(project.threadIds) ? project.threadIds.filter(Boolean).slice(-50) : [],
          createdAt: Number(project.createdAt) || now,
          updatedAt: Number(project.updatedAt) || Number(project.createdAt) || now,
        };
      }) : [],
      history: Array.isArray(parsed.history) ? parsed.history.slice(-100) : [],
      caps: { ...(parsed.caps || {}) },
    };
}

function loadState() {
  for (const candidate of [STATE_FILE, STATE_BACKUP_FILE]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (candidate === STATE_BACKUP_FILE) log('state restored from backup');
      return hydrateState(parsed);
    } catch {}
  }
  return structuredClone(DEFAULT_STATE);
}

function writeStateAtomic(s) {
  const body = JSON.stringify({ ...s, schemaVersion: STATE_SCHEMA_VERSION }, null, 2);
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    fs.writeFileSync(STATE_TEMP_FILE, body, 'utf8');
    if (fs.existsSync(STATE_FILE)) {
      try {
        JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
      } catch (error) {
        log('state backup skipped: current state is unreadable');
      }
    }
    fs.renameSync(STATE_TEMP_FILE, STATE_FILE);
  } catch (error) {
    try { fs.rmSync(STATE_TEMP_FILE, { force: true }); } catch {}
    log('saveState: ' + error.message);
  }
}

function flushState() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!pendingState) return;
  const next = pendingState;
  pendingState = null;
  writeStateAtomic(next);
}

function saveState(s, immediate = false) {
  pendingState = structuredClone(s);
  if (immediate) return flushState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 350);
  if (saveTimer.unref) saveTimer.unref();
}

function log(msg) {
  try {
    fs.mkdirSync(DIRS.logs, { recursive: true });
    let size = 0;
    try { size = fs.statSync(LOG_FILE).size; } catch {}
    if (size >= MAX_LOG_BYTES) {
      try { fs.rmSync(LOG_BACKUP_FILE, { force: true }); } catch {}
      try { fs.renameSync(LOG_FILE, LOG_BACKUP_FILE); } catch {}
    }
    fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n');
  } catch {}
}

module.exports = {
  DIRS, CODEX_HOME, CATALOG_FILE, ADMIN_TOKEN_FILE, PROXY_BASE,
  STATE_FILE, STATE_BACKUP_FILE, STATE_SCHEMA_VERSION,
  ensureDirs, loadState, saveState, flushState, log,
};
