'use strict';

// 验证 on-request 审批链路：要求模型尝试一次受保护写入，收到审批请求后明确拒绝。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { AppServerClient } = require('../src/appserver');

const workdir = process.argv[2] || path.join(os.homedir(), 'Documents', 'PetOffice', 'projects', 'PetOffice-Smoke');
const model = process.argv[3] || 'deepseek/deepseek-v4-flash';

async function main() {
  fs.mkdirSync(workdir, { recursive: true });
  const client = new AppServerClient();
  let approvalSeen = false;
  let completed = false;
  client.onEvent(event => {
    if (event.type === 'server-request') {
      approvalSeen = true;
      console.log('approval=' + event.method);
      client.respondToServerRequest(event.id, client.deniedResponse(event.method));
    }
    if (event.type === 'notification' && event.method === 'turn/completed') {
      completed = true;
      console.log('turn=' + ((event.params && event.params.turn && event.params.turn.status) || 'unknown'));
    }
  });
  const thread = await client.startThread({ cwd: workdir, model, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
  await client.startTurn({
    threadId: thread.threadId,
    model,
    text: 'Use a shell command to create C:\\Windows\\pet-office-approval-test.txt containing TEST. Do not use another location. If permission is denied, report that and stop.',
  });
  const deadline = Date.now() + 35000;
  while (!completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  client.stop();
  console.log('approvalSeen=' + approvalSeen + ' completed=' + completed);
  if (!approvalSeen || !completed) process.exitCode = 1;
}

main().catch(error => {
  console.error('approval smoke failed: ' + error.message);
  process.exitCode = 1;
});
