'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS, log } = require('./config');

let handler = null;
const pending = new Map();
const handled = new Set();
let watcher = null;

function setHandler(fn) { handler = fn; }

function startWatching() {
  try {
    const schedule = name => {
      if (!name.toLowerCase().endsWith('.json')) return;
      clearTimeout(pending.get(name));
      pending.set(name, setTimeout(() => {
        pending.delete(name);
        processOrder(path.join(DIRS.toPets, name));
      }, 350));
    };
    watcher = fs.watch(DIRS.toPets, { persistent: true }, (evt, file) => {
      const name = String(file || '');
      schedule(name);
    });
    // 关机或应用未启动时投递的任务，下一次启动仍应被处理。
    for (const name of fs.readdirSync(DIRS.toPets)) schedule(name);
  } catch (e) { log('bridge watch: ' + e.message); }
}

function stopWatching() {
  try { if (watcher) watcher.close(); } catch {}
  watcher = null;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}

function processOrder(full, tries = 0) {
  if (handled.has(full)) return;
  let raw;
  try { raw = fs.readFileSync(full, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return;
    if (tries < 4) return setTimeout(() => processOrder(full, tries + 1), 400);
    return log('bridge read: ' + e.message);
  }
  try {
    const order = JSON.parse(raw);
    handled.add(full);
    fs.mkdirSync(DIRS.processed, { recursive: true });
    try { fs.renameSync(full, path.join(DIRS.processed, Date.now() + '-' + path.basename(full))); } catch {}
    if (handler && order && order.action) handler(order);
  } catch (e) {
    // 编辑器/同步工具可能分块写入；短暂等待完整 JSON 后再判为坏任务。
    if (tries < 4) return setTimeout(() => processOrder(full, tries + 1), 400);
    log('bridge bad order: ' + e.message);
  }
}

function writeResult(name, content, meta) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIRS.fromPets, ts + '-' + name);
    fs.writeFileSync(base + '.md', content, 'utf8');
    if (meta) fs.writeFileSync(base + '.json', JSON.stringify(meta, null, 2), 'utf8');
    return base + '.md';
  } catch (e) { log('bridge writeResult: ' + e.message); return null; }
}

module.exports = { startWatching, stopWatching, setHandler, writeResult };
