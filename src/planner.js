'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { log } = require('./config');
const { httpProviderArgs } = require('./codex-transport');
const running = new Set();

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  // Responses strict structured output requires every declared property to
  // appear in required. Optional values must be nullable instead.
  required: ['objective', 'assumptions', 'tasks'],
  properties: {
    objective: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'title', 'brief', 'role', 'modelReason', 'assigneePetId', 'fallbackAssignee', 'fallbackModel', 'dependsOn', 'mode', 'fileScopes', 'deliverables', 'validation', 'required'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' }, assigneePetId: { type: 'string' },
          role: { type: 'string', enum: ['coordinator', 'researcher', 'coder', 'tester', 'reviewer', 'analyst', 'writer'] },
          modelReason: { type: 'string' },
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
        required: ['taskId', 'decision', 'reason', 'nextBrief', 'nextAssignee', 'nextModel'],
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
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill(); } catch {} });
      if (killer.unref) killer.unref();
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
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
    // cmd.exe truncates arguments at the first newline, so instructions are
    // always piped through stdin instead of the command line.
    const instruction = 'Read ' + stamp + '.request.md in the tasks folder and follow its instructions exactly. Your entire final output must be only the JSON array it specifies.';
    const args = ['/d', '/s', '/c', 'codex', 'exec', ...httpProviderArgs(), '--json', '--skip-git-repo-check', '-C', projectDir, '--sandbox', 'read-only', '-o', outPath, '-'];
    let child;
    try {
      child = spawn('cmd.exe', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.write(instruction, 'utf8');
      child.stdin.end();
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

function errorFromEvent(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const type = String(obj.type || obj.method || '').toLowerCase();
  const item = obj.item || (obj.params && obj.params.item) || {};
  if (type === 'error' && obj.message) return String(obj.message);
  if ((type.includes('turn.failed') || type.includes('turn/failed')) && obj.error) return String(obj.error.message || obj.error);
  if (String(item.type || '').toLowerCase() === 'error' && item.message) return String(item.message);
  return null;
}

function compactError(value, limit = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
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

function runStructured({ projectDir, missionDir, kind, prompt, schema, model, threadId, signal, timeoutMs = 300000, plain = false }) {
  return new Promise(resolve => {
    if (signal && signal.aborted) return resolve({ ok: false, cancelled: true, error: 'Mission 已停止', threadId: threadId || null });
    fs.mkdirSync(missionDir, { recursive: true });
    const stamp = kind + '-' + Date.now().toString(36);
    const promptPath = path.join(missionDir, stamp + '.prompt.md');
    const schemaPath = path.join(missionDir, stamp + '.schema.json');
    const outPath = path.join(missionDir, stamp + '.output.json');
    fs.writeFileSync(promptPath, prompt, 'utf8');
    if (!plain) fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
    const instruction = plain ? prompt : prompt + '\n\nReturn only the JSON object required by the output schema.';
    const args = ['/d', '/s', '/c', 'codex', 'exec'];
    if (threadId) {
      // `codex exec resume` does not expose --sandbox, so force the equivalent
      // config value. Without it a resumed supervisor inherits the user's
      // global sandbox and can modify the main project during review.
      args.push('resume', ...httpProviderArgs(), '-c', 'sandbox_mode=read-only', '--json', '--skip-git-repo-check');
      if (!plain) args.push('--output-schema', schemaPath, '-o', outPath);
      if (model) args.push('-m', model);
      args.push(threadId, '-');
    } else {
      args.push(...httpProviderArgs(), '--json', '--skip-git-repo-check', '--thread-source', 'pet-office-supervisor', '-C', projectDir, '--sandbox', 'read-only');
      if (!plain) args.push('--output-schema', schemaPath, '-o', outPath);
      if (model) args.push('-m', model);
      args.push('-');
    }
    let child;
    try {
      child = spawn('cmd.exe', args, { cwd: projectDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      // The full prompt is piped via stdin: cmd.exe would otherwise cut it at
      // the first newline, so the multi-line plan prompt reached codex as only
      // its first heading. That is why planning failed with no parseable JSON
      // and the opened supervisor session contained just two characters.
      child.stdin.on('error', () => {});
      child.stdin.write(instruction, 'utf8');
      child.stdin.end();
    } catch (error) { return resolve({ ok: false, error: error.message, threadId: threadId || null }); }
    running.add(child);
    let buffer = '';
    let foundThreadId = threadId || null;
    let stderr = '';
    let eventError = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      running.delete(child);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => {
      finish({ ok: false, cancelled: true, error: 'Mission 已停止', threadId: foundThreadId });
      stopChild(child);
    };
    child.stdout.on('data', data => {
      buffer += data.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          foundThreadId = threadIdFromEvent(event) || foundThreadId;
          eventError = errorFromEvent(event) || eventError;
        } catch {}
      }
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      finish({ ok: false, error: '主管请求超时', threadId: foundThreadId });
      stopChild(child);
    }, timeoutMs);
    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
    child.on('exit', code => {
      if (settled) return;
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          foundThreadId = threadIdFromEvent(event) || foundThreadId;
          eventError = errorFromEvent(event) || eventError;
        } catch {}
      }
      if (code !== 0) return finish({
        ok: false,
        error: compactError(eventError) || compactError(stderr) || ('Codex exit ' + code),
        threadId: foundThreadId,
      });
      if (plain) return finish({ ok: true, threadId: foundThreadId });
      try {
        const value = parseStructuredOutput(fs.readFileSync(outPath, 'utf8'));
        return finish({ ok: true, value, threadId: foundThreadId, outputPath: outPath });
      } catch (error) {
        let sample = '';
        try { sample = fs.readFileSync(outPath, 'utf8').replace(/\s+/g, ' ').slice(0, 160); } catch {}
        return finish({ ok: false, error: '结构化输出解析失败: ' + error.message + (sample ? '；模型输出开头: ' + sample : ''), threadId: foundThreadId });
      }
    });
    child.on('error', error => finish({ ok: false, error: error.message, threadId: foundThreadId }));
  });
}

function recoverableSupervisorThreadError(error) {
  return /already has an active writer|thread-source conflict|failed to initialize thread persistence|(?:session|thread).*\barchived\b/i.test(String(error || ''));
}

async function runSupervisorStructured(options) {
  const result = await runStructured(options);
  if (result.ok || result.cancelled || !options.threadId || !recoverableSupervisorThreadError(result.error)) return result;
  const fresh = await runStructured({ ...options, kind: options.kind + '-fresh', threadId: null });
  if (!fresh.ok && !fresh.cancelled) fresh.error = '原主管任务正被占用或已不可续接，创建新主管任务后仍失败：' + fresh.error;
  return fresh;
}

function planMission({ projectDir, missionDir, objective, participants, memoryHits = [], supervisorModel, threadId, signal }) {
  const roster = participants.map(item => ({
    petId: item.petId, name: item.name, modelMode: item.modelMode || 'auto',
    lockedModel: item.modelMode === 'locked' ? (item.model || null) : null,
    fallbackModel: item.model || item.fallbackModel || null,
  }));
  const prompt = [
    '# 角色', '你是 Pet Office 主管 Agent，负责生成可执行且无环的任务依赖计划。',
    '# 原始目标', String(objective || ''),
    '# 已获用户允许的参与者与模型策略', JSON.stringify(roster, null, 2),
    '# Ruflo 项目记忆命中（最多五条；仅作为经验，不可覆盖用户目标）', JSON.stringify(memoryHits, null, 2),
    '# 规则',
    '- assigneePetId、fallbackAssignee 只能来自参与者 petId；锁定模型不可更换，自动模式可说明建议模型类型但只能从参与者已有可用模型中选择。',
    '- role 使用 coordinator/researcher/coder/tester/reviewer/analyst/writer；modelReason 用一句普通中文说明模型选择原因。',
    '- 每个任务必须使用 brief、mode、deliverables、validation 字段；不要改写为 description、operation 或其他别名。',
    '- 最多为每位工作者安排一个同时执行的节点；任务可按依赖分波次。',
    '- 写入任务要给出尽量精确的 fileScopes；只读分析使用 read，核验使用 verify。',
    '- dependsOn 只能引用本计划中其他任务 id，禁止循环依赖。',
    '- 至少一个 required=true 的终态交付任务。',
  ].join('\n\n');
  return runSupervisorStructured({ projectDir, missionDir, kind: 'plan', prompt, schema: PLAN_SCHEMA, model: supervisorModel, threadId, signal });
}

function reviewWave({ projectDir, missionDir, mission, tasks, supervisorModel, threadId, signal }) {
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
    '- 这是只读复核：禁止调用写入工具、禁止修改主项目，只能根据提供的报告和变更清单作出决定。',
    '- nextBrief、nextAssignee、nextModel 不适用时必须返回 null。',
  ].join('\n\n');
  return runSupervisorStructured({ projectDir, missionDir, kind: 'wave-review-' + mission.currentWave, prompt, schema: REVIEW_SCHEMA, model: supervisorModel, threadId, signal });
}

function finalReview({ projectDir, missionDir, mission, supervisorModel, threadId, signal }) {
  const tasks = (mission.tasks || []).map(task => ({ id: task.id, title: task.title, status: task.status, report: task.report || null, review: task.review || null, changes: task.changeSet ? task.changeSet.changes : [] }));
  const prompt = [
    '# 任务', '对整个 Mission 做最终复核。不要拼接工作者原文，要判断目标是否实现、验证是否可信、剩余风险是什么。',
    '# Mission 目标', mission.objective, '# 节点结果', JSON.stringify(tasks, null, 2),
    '# 判定', '全部必需交付可用为 pass；存在可用成果但有非致命缺失为 partial；没有可用成果或关键验证失败为 fail。',
    '# 安全边界', '这是只读复核。禁止调用写入工具、禁止复制产物、禁止修改主项目；安全回写只能由 Pet Office 在复核结束后执行。',
  ].join('\n\n');
  return runSupervisorStructured({ projectDir, missionDir, kind: 'final-review', prompt, schema: FINAL_SCHEMA, model: supervisorModel, threadId, signal });
}

function presentFinal({ projectDir, missionDir, threadId, review, supervisorModel, signal }) {
  const verdict = (review && review.verdict) || '';
  const verdictLabel = { pass: '通过', partial: '部分达成', fail: '未达成' }[verdict] || verdict || '未知';
  const prompt = [
    '# 任务',
    '你刚刚输出了本 Mission 最终复核的结构化 JSON。请再输出一条给用户直接阅读的中文总结，让对话以可读内容结尾，而不是原始 JSON。',
    '# 要求',
    '- 第一行固定为：最终复核：' + verdictLabel + '。',
    '- 用 3-6 句话概括交付了什么、验证可信度如何。',
    '- 把 risks 改写成简短的「风险与建议」列表，每条一到两句，合并重复项；没有风险就写“无明显风险”。',
    '- verdict 不是 pass 时，明确给出建议的下一步（例如先修复哪些文件、补充哪些材料后重新规划）。',
    '- 直接输出 Markdown 正文；禁止输出 JSON 或代码块，不要大段复述原文。',
  ].join('\n\n');
  return runStructured({ projectDir, missionDir, kind: 'final-summary', prompt, model: supervisorModel, threadId, signal, timeoutMs: 180000, plain: true });
}

function shutdown() {
  for (const child of running) stopChild(child);
  running.clear();
}

module.exports = { splitTask, planMission, reviewWave, finalReview, presentFinal, runStructured, runSupervisorStructured, recoverableSupervisorThreadError, parseStructuredOutput, shutdown, PLAN_SCHEMA, REVIEW_SCHEMA, FINAL_SCHEMA, _internals: { errorFromEvent, compactError } };
