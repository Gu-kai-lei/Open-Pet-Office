'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const code = source.slice(source.indexOf('function cancelActivityMotion('), source.indexOf('function bindActivity('));

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...items) => items.forEach(item => values.add(item)),
    remove: (...items) => items.forEach(item => values.delete(item)),
    contains: item => values.has(item),
    toggle: (item, force) => force ? values.add(item) : values.delete(item),
    values,
  };
}

const animations = [];
const panel = {
  classList: classList(['hidden', 'ui']),
  style: {}, scrollHeight: 360, offsetWidth: 430,
  getBoundingClientRect() {
    return {
      left: Number.parseFloat(this.style.left) || 300,
      top: Number.parseFloat(this.style.top) || 300,
      width: Number.parseFloat(this.style.width) || 430,
      height: Number.parseFloat(this.style.height) || 360,
    };
  },
  getAnimations() { return animations.filter(animation => !animation.cancelled); },
  animate() {
    const animation = { onfinish: null, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  },
  removeAttribute(name) { if (name === 'style') this.style = {}; },
};
Object.defineProperty(panel, 'className', {
  get: () => [...panel.classList.values].join(' '),
  set: value => { panel.classList.values.clear(); String(value).split(/\s+/).filter(Boolean).forEach(item => panel.classList.values.add(item)); },
});

const button = { getBoundingClientRect: () => ({ left: 480, top: 180, width: 36, height: 36, bottom: 216 }) };
const quickbar = { getBoundingClientRect: () => ({ left: 450, top: 170, width: 96, height: 44, bottom: 214 }) };
const bossElement = {
  classList: classList(),
  querySelector: selector => selector === '[data-activity]' ? button : quickbar,
};
const other = { classList: classList(['hidden']) };
const timers = new Map();
let nextTimer = 1;
let refreshes = 0;
const context = {
  activitySurface: { state: 'closed', epoch: 0, timer: null, animation: null },
  pets: new Map([['supervisor', { el: bossElement }]]),
  innerWidth: 1920, innerHeight: 1080,
  lastPointer: { x: 0, y: 0 },
  $: selector => selector === '#activity' ? panel : other,
  document: { elementFromPoint: () => null },
  motionReduced: () => false,
  hideLiveTaskCard() {}, closeComposer() {}, updateLiveTaskCard() {}, syncMouseCapture() {},
  refreshActivityContents() { refreshes++; },
  setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
  openPanelFor: null,
  Math,
};
vm.createContext(context);
vm.runInContext(code, context);

context.openActivity();
assert.equal(context.activitySurface.state, 'opening');
let finish = context.activitySurface.animation.onfinish;
finish();
assert.equal(context.activitySurface.state, 'open');
assert.equal(panel.classList.contains('hidden'), false);

context.openActivity();
assert.equal(context.activitySurface.state, 'closing');
const staleClose = context.activitySurface.animation.onfinish;
context.openActivity();
assert.equal(context.activitySurface.state, 'opening');
staleClose();
assert.equal(context.activitySurface.state, 'opening');
assert.equal(panel.classList.contains('hidden'), false);
context.activitySurface.animation.onfinish();
assert.equal(context.activitySurface.state, 'open');

const staleCallbacks = [];
for (let index = 0; index < 10; index++) {
  context.openActivity();
  if (context.activitySurface.animation && context.activitySurface.animation.onfinish) staleCallbacks.push(context.activitySurface.animation.onfinish);
}
assert.equal(context.activitySurface.state, 'opening');
const latest = context.activitySurface.animation.onfinish;
for (const callback of staleCallbacks.slice(0, -1)) callback();
assert.equal(context.activitySurface.state, 'opening');
latest();
assert.equal(context.activitySurface.state, 'open');

const beforeRefresh = context.activitySurface.state;
context.refreshActivityContents();
assert.equal(context.activitySurface.state, beforeRefresh);
assert.ok(refreshes >= 1);

context.closeActivity();
context.activitySurface.animation.onfinish();
assert.equal(context.activitySurface.state, 'closed');
assert.equal(panel.classList.contains('hidden'), true);
console.log('activity state machine: reopen race, rapid toggles and refresh stability OK');
