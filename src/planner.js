'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./config');

// 让主管模型把任务拆成 N 份简报。成功返回 [{name, brief}]，失败返回 null。
function splitTask({ projectDir, text, participants }) {
  return new Promise(resolve => {
    const stamp = 'plan-' + Date.now().toString(36);
    const reqPath = path.join(projectDir, 'tasks', stamp + '.request.md');
    const outPath = path.join(projectDir, 'tasks', stamp + '.plan.txt');
    const inst = [
      '你是团队主管。下面是一个任务和参与者名单。',
      '参与者: ' + participants.join(', '),
      '请把任务拆分成与参与者一一对应的简报（每人一份，具体、可执行；如果某人本任务确实无事可做，brief 给一句简短说明）。',
      '严格输出一个 JSON 数组，不要输出任何其他文字。格式:',
      '[{"name":"<参与者名>","brief":"<该成员的具体任务简报，中文>"}]',
      '',
      '# 任务',
      String(text || ''),
    ].join('\n');
    try { fs.writeFileSync(reqPath, inst, 'utf8'); } catch (e) { log('planner write: ' + e.message); return resolve(null); }
    const args = ['/c', 'codex', 'exec', '--json', '--skip-git-repo-check', '-C', projectDir, '--sandbox', 'read-only', '-o', outPath,
      'Read ' + stamp + '.request.md in the tasks folder and follow its instructions exactly. Your entire final output must be only the JSON array it specifies.'];
    let child;
    try {
      child = spawn('cmd.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const raw = fs.readFileSync(outPath, 'utf8');
        const m = raw.match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr) && arr.length) return resolve(arr.filter(x => x && x.name && typeof x.brief === 'string'));
      } catch {}
      resolve(null);
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

module.exports = { splitTask };
