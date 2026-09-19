'use strict';

// 真实连一次 codex app-server：建线程 → 发一条消息 → 打印事件流，验证协议链路。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { AppServerClient } = require('../src/appserver');

const workdir = process.argv[2] || path.join(os.homedir(), 'Documents', 'PetOffice', 'projects', 'PetOffice-Smoke');
const model = process.argv[3] || null;

async function main() {
  fs.mkdirSync(workdir, { recursive: true });
  const client = new AppServerClient();
  const seen = new Map();
  client.onEvent(event => {
    if (event.type === 'notification') {
      seen.set(event.method, (seen.get(event.method) || 0) + 1);
      const params = event.params || {};
      const text = params.delta || (params.item && params.item.text) || '';
      if (event.method === 'error') console.log('[error] ' + JSON.stringify(params).slice(0, 500));
      else if (event.method === 'item/completed') console.log('[item/completed] ' + JSON.stringify(params).slice(0, 600));
      else if (text) console.log('[event] ' + event.method + ' :: ' + String(text).slice(0, 160));
    } else if (event.type === 'server-request') {
      console.log('[server-request] ' + event.method);
    }
  });
  const thread = await client.startThread({ cwd: workdir, model });
  console.log('threadId=' + thread.threadId);
  console.log('thread/start raw=' + JSON.stringify(thread.result).slice(0, 400));
  await client.startTurn({ threadId: thread.threadId, text: 'Reply with exactly: PET_OFFICE_OK', model });
  await new Promise(resolve => setTimeout(resolve, 25000));
  console.log('notification summary: ' + JSON.stringify([...seen.entries()].sort()));
  client.stop();
  process.exit(0);
}

main().catch(error => {
  console.error('smoke failed: ' + (error && error.message));
  process.exit(1);
});
