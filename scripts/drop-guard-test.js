'use strict';
// Real-Electron regression test for dropping multiple links onto a pet.
// Windows ends an OLE drag session with a synthesized mouse sequence at the
// release point; without the drop guard the pet click handler closes the
// composer that the previous drop opened.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const repo = process.argv[2] || path.resolve(__dirname, '..');
const qa = path.join(__dirname, 'electron-drop-guard');
const home = path.join(qa, 'home-' + Date.now());
fs.mkdirSync(home, { recursive: true });
require('os').homedir = () => home;
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(home, 'electron'));
app.getVersion = () => require(path.join(repo, 'package.json')).version;
app.requestSingleInstanceLock = () => true;
app.setLoginItemSettings = () => {};
const cfg = require(path.join(repo, 'src/config'));
cfg.ensureDirs();
const state = cfg.loadState();
state.settings = { ...state.settings, autoCheckUpdates: false, reducedMotion: true, themeMode: 'warm' };
cfg.saveState(state, true);
require(path.join(repo, 'src/quota')).fetchQuotas = async () => ({ ok: true, reports: [], at: Date.now() });
require(path.join(repo, 'src/main'));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const js = source => win.webContents.executeJavaScript(source, true);
async function until(source, label) {
  const limit = Date.now() + 10000;
  while (Date.now() < limit) {
    if (await js(source)) return;
    await wait(100);
  }
  throw new Error('drop guard check timed out: ' + label);
}
function dropLink(url) {
  return js("(() => {" +
    "const dt = new DataTransfer();" +
    "dt.setData('text/uri-list', " + JSON.stringify(url) + ");" +
    "dt.setData('text/plain', " + JSON.stringify(url) + ");" +
    "const pet = pets.get('supervisor').el;" +
    "pet.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt}));" +
    "pet.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt}));" +
    "})()");
}

app.whenReady().then(async () => {
  const checks = [];
  try {
    for (let attempt = 0; attempt < 100 && !BrowserWindow.getAllWindows().length; attempt++) await wait(100);
    win = BrowserWindow.getAllWindows()[0];
    assert.ok(win, 'main window was not created');
    await wait(1200);
    await until("!!S && pets.size === 5", 'renderer initialized');

    // Track mouse-capture decisions from the main process: contextBridge APIs
    // cannot be reassigned in the renderer, so sniff the IPC channel instead.
    const ignoreLog = [];
    win.webContents.on('ipc-message', (_event, channel, ...args) => {
      if (channel === 'mouse:ignore') ignoreLog.push(!!args[0]);
    });

    await dropLink('https://example.com/first');
    await until("composerAttachments.filter(a=>a.type==='link').length===1 && !$('#composer').classList.contains('hidden')", 'first link opens composer');
    await wait(400);
    assert.equal(await js("composerPetId"), 'supervisor', 'composer target must be settled before the synthesized sequence');
    checks.push('first link opens composer');

    // The exact synthesized sequence Windows fires after OLE drop: pointerdown
    // on the pet, then click. Assert after each step so a regression cannot
    // hide behind event ordering.
    await js("(() => {" +
      "const pet = pets.get('supervisor').el;" +
      "pet.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0}));" +
      "})()");
    await wait(100);
    assert.equal(await js("$('#composer').classList.contains('hidden')"), false, 'synthesized pointerdown must not close composer');
    await js("pets.get('supervisor').el.dispatchEvent(new MouseEvent('click', {bubbles:true}))");
    await wait(100);
    assert.equal(await js("$('#composer').classList.contains('hidden')"), false, 'composer was closed by synthesized events');
    assert.equal(await js("composerPetId"), 'supervisor');
    assert.equal(await js("composerAttachments.filter(a=>a.type==='link').length"), 1, 'attachment list was reset');
    checks.push('synthesized click and pointerdown after drop cannot close composer');
    await js("$('#stage').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0}))");
    await wait(100);
    assert.equal(await js("$('#composer').classList.contains('hidden')"), false, 'stage pointerdown after drop must not close composer');
    checks.push('background pointerdown after drop cannot close composer');

    // The real "second window" scenario: after the first link the user clicks
    // the browser to grab the next link. The pet window is fullscreen and
    // transparent, so that click lands on our stage unless the composer-only
    // state keeps the window click-through outside the composer and pets.
    await js("document.body.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, clientX:40, clientY:40}))");
    await wait(150);
    assert.equal(ignoreLog[ignoreLog.length - 1], true, 'blank desktop must stay click-through while only the composer is open');
    assert.equal(await js("$('#composer').classList.contains('hidden')"), false, 'click-through state must keep the composer open');
    checks.push('clicking another window stays click-through and keeps composer open');
    await js("$('#c-text').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, clientX:100, clientY:100}))");
    await wait(150);
    assert.equal(ignoreLog[ignoreLog.length - 1], false, 'hovering the composer must restore mouse capture');
    checks.push('hovering the composer restores mouse capture');

    // After the guard expires the user drops a second link; composer stays open.
    await wait(900);
    // A second drag session re-arms the guard while hovering for the drop.
    await js("(() => {" +
      "const dt = new DataTransfer();" +
      "dt.setData('text/uri-list', 'https://example.com/second');" +
      "const pet = pets.get('supervisor').el;" +
      "pet.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt}));" +
      "pet.dispatchEvent(new MouseEvent('click', {bubbles:true}));" +
      "$('#stage').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0}));" +
      "})()");
    await wait(150);
    assert.equal(await js("$('#composer').classList.contains('hidden')"), false, 'guard must re-arm during the second drag hover');
    checks.push('second drag hover re-arms the drop guard');
    await wait(800);
    await dropLink('https://example.com/second');
    await until("composerAttachments.filter(a=>a.type==='link').length===2 && !$('#composer').classList.contains('hidden')", 'second link appends');
    checks.push('second link appends to the still-open composer');

    // Normal pet interaction must keep working once the guard expires.
    await wait(900);
    await js("pets.get('supervisor').el.click()");
    await until("!$('#panel').classList.contains('hidden')", 'normal click still opens panel');
    checks.push('normal pet click still opens the panel');

    // Dropping onto the composer surface appends there as well.
    await js("closeComposer(true);openComposer('supervisor',false)");
    await dropLink('https://example.com/third');
    await until("composerAttachments.filter(a=>a.type==='link').length===1", 'drop onto composer appends');
    checks.push('drop onto open composer appends without reset');

    fs.writeFileSync(path.join(qa, 'result.json'), JSON.stringify({ ok: true, checks }, null, 2));
    console.log('DROP_GUARD_PASS ' + checks.length);
  } catch (error) {
    fs.writeFileSync(path.join(qa, 'result.json'), JSON.stringify({ ok: false, checks, error: error.stack, debug: globalThis.debugState || null }, null, 2));
    console.error(error.stack);
  }
  setTimeout(() => app.quit(), 600);
});
