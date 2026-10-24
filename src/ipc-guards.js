'use strict';

// The renderer displays model output, so every patch it sends is treated as
// untrusted. Only keys that the settings UI actually edits may reach state.
const RENDERER_SETTINGS = new Set([
  'autostart', 'compactMode', 'reducedMotion', 'themeMode', 'petScale', 'displayMode', 'fullscreenBehavior',
  'notificationMode', 'fontScale', 'fontFamily', 'autoCheckUpdates', 'toggleShortcut', 'captureShortcut',
  'maxParallel',
]);
const RENDERER_UI = new Set(['delegationOn', 'hiddenPets', 'petPositions', 'taskProjectFilter', 'pinnedLiveTaskKey']);

function pickKeys(patch, allowed) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  return Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key)));
}

module.exports = { RENDERER_SETTINGS, RENDERER_UI, pickKeys };
