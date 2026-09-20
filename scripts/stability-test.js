'use strict';

const assert = require('node:assert/strict');
const { AppServerClient } = require('../src/appserver');
const { _internals: diagnostics } = require('../src/diagnostics');

(async () => {
  const timed = new AppServerClient();
  timed.child = { stdin: { write() {} } };
  await assert.rejects(() => timed.request('test/timeout', {}, 25), /请求超时/);
  assert.equal(timed.pending.size, 0);
  assert.match(timed.health().lastError, /test\/timeout/);

  const stopped = new AppServerClient();
  stopped.child = { stdin: { write() {}, end() {} }, kill() {} };
  const pending = stopped.request('test/stop', {}, 5000);
  stopped.stop();
  await assert.rejects(() => pending, /stopped/);
  assert.equal(stopped.pending.size, 0);

  const secret = diagnostics.safeText('Authorization=Bearer abcdefghijklmnop token=super-secret sk-1234567890abcdef');
  assert.doesNotMatch(secret, /abcdefgh|super-secret|1234567890abcdef/);
  assert.match(secret, /隐藏/);

  console.log('stability: app-server timeout, stop cleanup and diagnostic redaction OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
