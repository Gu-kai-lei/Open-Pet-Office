'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./config');
const running = new Set();

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['objective', 'tasks'],
  properties: {
    objective: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'brief', 'assigneePetId', 'dependsOn', 'mode', 'fileScopes', 'deliverables', 'validation', 'required'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' }, assigneePetId: { type: 'string' },
          fallbackAssignee: { type: ['string', 'null'] }, fallbackModel: { type: ['string', 'null'] },
          dependsOn: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['read', 'write', 'verify'] },
          fileScopes: { type: 'array', items: { type: 'string' } }, deliverables: { type: 'array', items: { type: 'string' } },
          validation: { type: 'array', items: { type: 'string' } }, required: { type: 'boolean' },
        },
      },
    },
  },
};

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'decisions'],
  properties: {
    summary: { type: 'string' },
    decisions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['taskId', 'decision', 'reason'],
        properties: {
          taskId: { type: 'string' }, decision: { type: 'string', enum: ['accept', 'retry', 'reassign', 'fail', 'skip'] },
          reason: { type: 'string' }, nextBrief: { type: ['string', 'null'] }, nextAssignee: { type: ['string', 'null'] }, nextModel: { type: ['string', 'null'] },
        },
      },
    },
  },
};

const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'summary', 'validationSummary', 'risks'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },
    summary: { type: 'string' }, validationSummary: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
};

function stopChild(child) {
  if (!child) return;
  try { child.kill(); } catch {}
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      if (killer.unref) killer.unref();
    } catch {}
  }
}

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
    running.add(child);
    const timer = setTimeout(() => stopChild(child), 180000);
    child.on('exit', () => {
      running.delete(child);
      clearTimeout(timer);
      try {
        const raw = fs.readFileSync(outPath, 'utf8');
        const m = raw.match(/\[[\s\S]*\]/);
        const arr = JSON.parse(m[0]);
        if (Array.isArray(arr) && arr.length) return resolve(arr.filter(x => x && x.name && typeof x.brief === 'string'));
      } catch {}
      resolve(null);
    });
    child.on('error', () => { running.delete(child); clearTimeout(timer); resolve(null); });
  });
}

function threadIdFromEvent(obj) {
  return obj && (obj.thread_id || obj.session_id || (obj.thread && obj.thread.id) || (obj.msg && (obj.msg.thread_id || obj.msg.id)));
}

function parseStructuredOutput(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
  throw new Error('输出中没有可解析的 JSON 对象');
}

function runStructured({ projectDir, missionDir, kind, prompt, schema, model, threadId, timeoutMs = 300000 }) {
  return new Promise(resolve => {
    fs.mkdirSync(missionDir, { recursive: true });
    const stamp = kind + '-' + Date.now().toString(36);
    const promptPath = path.join(missionDir, stamp + '.prompt.md');
    const schemaPath = path.join(missionDir, stamp + '.schema.json');
    const outPath = path.join(missionDir, stamp + '.output.json');
    fs.writeFileSync(promptPath, prompt, 'utf8');
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
    const instruction = prompt + '\n\nReturn only the JSON object required by the output schema.';
    const args = ['/c', 'codex', 'exec'];
    if (threadId) {
      args.push('resume', '--json', '--output-schema', schemaPath, '-o', outPath);
      if (model) args.push('-m', model);
      args.push(threadId, instruction);
    } else {
      args.push('--json', '--skip-git-repo-check', '--thread-source', 'pet-office-supervisor', '-C', projectDir, '--sandbox', 'read-only', '--output-schema', schemaPath, '-o', outPath);
      if (model) args.push('-m', model);
      args.push(instruction);
    }
    let child;
    try { child = spawn('cmd.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return resolve({ ok: false, error: error.message, threadId: threadId || null }); }
    running.add(child);
    let buffer = '';
    let foundThreadId = threadId || null;
    let stderr = '';
    child.stdout.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        try { foundThreadId = threadIdFromEvent(JSON.parse(line)) || foundThreadId; } catch {}
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    const timer = setTimeout(() => stopChild(child), timeoutMs);
    child.on('exit', code => {
      running.delete(child);
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: stderr.trim() || ('Codex exit ' + code), threadId: foundThreadId });
      try {
        const value = parseStructuredOutput(fs.readFileSync(outPath, 'utf8'));
        return resolve({ ok: true, value, threadId: foundThreadId, outputPath: outPath });
      } catch (error) {
        return resolve({ ok: false, error: '结构化输出解析失败: ' + error.message, threadId: foundThreadId });
      }
    });
    child.on('error', error => { running.delete(child); clearTimeout(timer); resolve({ ok: false, error: error.message, threadId: foundThreadId }); });
  });
}

function planMission({ projectDir, missionDir, objective, participants, supervisorModel, threadId }) {
  const roster = participants.map(item => ({ petId: item.petId, name: item.name, model: item.model || null, fallbackModel: item.fallbackModel || null }));
  const prompt = [
    '# 角色', '你是 Pet Office 主管 Agent，负责生成可执行且无环的任务依赖计划。',
    '# 原始目标', String(objective || ''),
    '# 已获用户允许的参与者与模型', JSON.stringify(roster, null, 2),
    '# 规则',
    '- assigneePetId、fallbackAssignee 只能来自参与者 petId；fallbackModel 只能使用相应参与者已列出的 model 或 fallbackModel。',
    '- 最多为每位工作者安排一个同时执行的节点；任务可按依赖分波次。',
    '- 写入任务要给出尽量精确的 fileScopes；只读分析使用 read，核验使用 verify。',
    '- dependsOn 只能引用本计划中其他任务 id，禁止循环依赖。',
    '- 至少一个 required=true 的终态交付任务。',
  ].join('\n\n');
  return runStructured({ projectDir, missionDir, kind: 'plan', prompt, schema: PLAN_SCHEMA, model: supervisorModel, threadId });
}

function reviewWave({ projectDir, missionDir, mission, tasks, supervisorModel, threadId }) {
  const reports = tasks.map(task => ({
    taskId: task.id, title: task.title, status: task.status, attempts: task.attempts,
    assigneePetId: task.assigneePetId, model: task.model, report: task.report || null,
    changes: task.changeSet ? task.changeSet.changes : [], error: task.error || null,
  }));
  const prompt = [
    '# 任务', '检查本波次工作结果。只接受确实满足交付物和验证要求的节点。',
    '# Mission 目标', mission.objective,
    '# 本波次结果', JSON.stringify(reports, null, 2),
    '# 决策规则',
    '- 成功且充分：accept。', '- 可通过修改简报再次尝试：retry。', '- 需要换已确认参与者：reassign。',
    '- 不可恢复：fail。', '- 非必需且无需继续：skip。', '- 每个 taskId 必须且只能出现一次。',
  ].join('\n\n');
  return runStructured({ projectDir, missionDir, kind: 'wave-review-' + mission.currentWave, prompt, schema: REVIEW_SCHEMA, model: supervisorModel, threadId });
}

function finalReview({ projectDir, missionDir, mission, supervisorModel, threadId }) {
  const tasks = (mission.tasks || []).map(task => ({ id: task.id, title: task.title, status: task.status, report: task.report || null, review: task.review || null, changes: task.changeSet ? task.changeSet.changes : [] }));
  const prompt = [
    '# 任务', '对整个 Mission 做最终复核。不要拼接工作者原文，要判断目标是否实现、验证是否可信、剩余风险是什么。',
    '# Mission 目标', mission.objective, '# 节点结果', JSON.stringify(tasks, null, 2),
    '# 判定', '全部必需交付可用为 pass；存在可用成果但有非致命缺失为 partial；没有可用成果或关键验证失败为 fail。',
  ].join('\n\n');
  return runStructured({ projectDir, missionDir, kind: 'final-review', prompt, schema: FINAL_SCHEMA, model: supervisorModel, threadId });
}

function shutdown() {
  for (const child of running) stopChild(child);
  running.clear();
}

module.exports = { splitTask, planMission, reviewWave, finalReview, runStructured, parseStructuredOutput, shutdown, PLAN_SCHEMA, REVIEW_SCHEMA, FINAL_SCHEMA };
