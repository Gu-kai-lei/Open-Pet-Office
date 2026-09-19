'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petOffice', {
  getState: () => ipcRenderer.invoke('state:get'),
  setMouseIgnore: b => ipcRenderer.send('mouse:ignore', b),
  startTask: payload => ipcRenderer.invoke('task:start', payload),
  startChat: payload => ipcRenderer.invoke('chat:start', payload),
  respondInteraction: payload => ipcRenderer.invoke('interaction:respond', payload),
  cancelTask: id => ipcRenderer.invoke('task:cancel', id),
  createProject: name => ipcRenderer.invoke('project:create', name),
  addProject: () => ipcRenderer.invoke('project:add'),
  selectProject: id => ipcRenderer.invoke('project:select', id),
  setSettings: patch => ipcRenderer.invoke('settings:set', patch),
  setUi: patch => ipcRenderer.invoke('ui:set', patch),
  renamePet: (petId, name) => ipcRenderer.invoke('pet:rename', { petId, name }),
  setModel: (petId, model) => ipcRenderer.invoke('pet:model', { petId, model }),
  setSkin: (petId, skin) => ipcRenderer.invoke('pet:skin', { petId, skin }),
  skinData: slug => ipcRenderer.invoke('skin:data', slug),
  refreshSkins: () => ipcRenderer.invoke('skins:refresh'),
  setCap: (petId, cap) => ipcRenderer.invoke('cap:set', { petId, cap }),
  openPath: p => ipcRenderer.invoke('shell:open', p),
  openCodex: threadId => ipcRenderer.invoke('codex:open', threadId),
  openPetdex: () => ipcRenderer.invoke('petdex:open'),
  pathForFile: file => {
    try {
      const { webUtils } = require('electron');
      if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file) || null;
    } catch {}
    return (file && file.path) || null;
  },
  ingestFiles: paths => ipcRenderer.invoke('files:ingest', { paths: Array.isArray(paths) ? paths : [] }),
  refreshQuota: () => ipcRenderer.invoke('quota:refresh'),
  hideApp: () => ipcRenderer.invoke('app:hide'),
  showApp: () => ipcRenderer.invoke('app:show'),
  quit: () => ipcRenderer.invoke('app:quit'),
  on: (ch, fn) => ipcRenderer.on(ch, (e, d) => fn(d)),
});
