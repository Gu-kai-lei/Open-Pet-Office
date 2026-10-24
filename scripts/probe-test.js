'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ForegroundProbe, isFullscreenBounds } = require('../src/fullscreen-probe');

function fakeSpawn(behaviour) {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin.write = () => behaviour(child, children.length);
    children.push(child);
    setImmediate(() => child.stdout.emit('data', 'ready\r\n'));
    return child;
  };
  return { spawnImpl, children };
}

(async () => {
  const rect = { x: 0, y: 0, width: 1920, height: 1080, pid: 7, class: 'Game' };
  const ok = fakeSpawn(child => setImmediate(() => child.stdout.emit('data', JSON.stringify(rect) + '\r\n')));
  const probe = new ForegroundProbe({ spawnImpl: ok.spawnImpl });
  for (let index = 0; index < 5; index++) assert.deepEqual(await probe.probe(500), rect);
  assert.equal(ok.children.length, 1, 'one helper process serves every probe');
  assert.ok(isFullscreenBounds(rect, { x: 0, y: 0, width: 1920, height: 1080 }));
  probe.stop();
  assert.equal(ok.children[0].killed, true);

  // A wedged helper times out, is killed, and is replaced after backoff.
  const wedged = fakeSpawn((child, count) => { if (count > 1) setImmediate(() => child.stdout.emit('data', 'null\n')); });
  const flaky = new ForegroundProbe({ spawnImpl: wedged.spawnImpl });
  assert.equal(await flaky.probe(50), null);
  assert.equal(wedged.children[0].killed, true);
  assert.equal(await flaky.probe(50), null, 'backoff prevents an immediate relaunch');
  assert.equal(wedged.children.length, 1);
  flaky.retryAt = 0;
  assert.equal(await flaky.probe(500), null, 'replacement answers normally (no foreground window)');
  assert.equal(wedged.children.length, 2);
  flaky.stop();

  // A crashed helper resolves pending probes instead of hanging the timer loop.
  const crashing = fakeSpawn(child => setImmediate(() => child.emit('exit', 1)));
  const crashed = new ForegroundProbe({ spawnImpl: crashing.spawnImpl });
  assert.equal(await crashed.probe(1000), null);
  assert.equal(crashed.child, null);

  console.log('foreground probe: persistent helper, timeout replacement, backoff and crash handling OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
