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
  projectsRoot: path.join(HOME, 'Documents', 'PetOffice', 'projects'),
  petdexPets: path.join(HOME, '.petdex', 'pets'),
};
const CODEX_HOME = path.join(HOME, '.codex');
const CATALOG_FILE = path.join(CODEX_HOME, 'opencodex-catalog.json');
const OPENCODEX_HOME = path.join(HOME, '.opencodex');
const ADMIN_TOKEN_FILE = path.join(OPENCODEX_HOME, 'admin-api-token');
const PROXY_BASE = 'http://127.0.0.1:10100';
const STATE_FILE = path.join(APP_DIR, 'state.json');

const DEFAULT_STATE = {
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
  },
  ui: {
    delegationOn: false,
    hiddenPets: ['w1', 'w2', 'w3', 'w4'],
    petPositions: {},
  },
  pets: {
    supervisor: { name: 'Michael', model: null, skin: null },
    workers: [
      { id: 'w1', name: '小蓝', model: null, skin: null },
      { id: 'w2', name: '小绿', model: null, skin: null },
      { id: 'w3', name: '小橙', model: null, skin: null },
      { id: 'w4', name: '小紫', model: null, skin: null },
    ],
  },
  caps: {},
};

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const parsedPets = parsed.pets || {};
    const parsedWorkers = Array.isArray(parsedPets.workers) ? parsedPets.workers : [];
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      pets: {
        supervisor: { ...DEFAULT_STATE.pets.supervisor, ...(parsedPets.supervisor || {}) },
        workers: DEFAULT_STATE.pets.workers.map(worker => ({
          ...worker,
          ...(parsedWorkers.find(item => item.id === worker.id) || {}),
        })),
      },
      ui: { ...DEFAULT_STATE.ui, ...(parsed.ui || {}) },
      history: Array.isArray(parsed.history) ? parsed.history.slice(-100) : [],
      caps: { ...(parsed.caps || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) { log('saveState: ' + e.message); }
}

function log(msg) {
  try { fs.appendFileSync(path.join(DIRS.logs, 'app.log'), '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch {}
}

module.exports = { DIRS, CODEX_HOME, CATALOG_FILE, ADMIN_TOKEN_FILE, PROXY_BASE, STATE_FILE, ensureDirs, loadState, saveState, log };
