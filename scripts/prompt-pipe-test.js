'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const planner = require('../src/planner');
const dispatcher = require('../src/dispatcher');

if (process.platform !== 'win32') {
  console.log('prompt pipe tests skipped (Windows only)');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-prompt-pipe-'));
const bin = path.join(root, 'bin');
const project = path.join(root, 'project');
const missionDir = path.join(root, 'mission');
const capturePath = path.join(root, 'prompt.txt');
const argsPath = path.join(root, 'args.txt');
const cwdPath = path.join(root, 'cwd.txt');
const fakeOutputPath = path.join(root, 'fake-output.txt');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(project, { recursive: true });

fs.writeFileSync(path.join(bin, 'codex.cmd'), [
  '@echo off',
  'setlocal',
  '> "%PET_OFFICE_ARGS_CAPTURE%" echo %*',
  '> "%PET_OFFICE_CWD_CAPTURE%" echo %CD%',
  'if not defined PET_OFFICE_FAIL_RESUME goto capture_prompt',
  'if exist "%PET_OFFICE_FAIL_MARKER%" goto capture_prompt',
  '> "%PET_OFFICE_FAIL_MARKER%" echo failed',
  '1>&2 echo thread-source conflict: thread already has an active writer',
  'exit /b 1',
  ':capture_prompt',
  'more > "%PET_OFFICE_PROMPT_CAPTURE%"',
  'set "OUT="',
  ':parse',
  'if "%~1"=="" goto done',
  'if "%~1"=="-o" goto output',
  'shift',
  'goto parse',
  ':output',
  'shift',
  'set "OUT=%~1"',
  ':done',
  'echo {"thread_id":"pipe-test-thread"}',
  'if defined OUT copy /y "%PET_OFFICE_FAKE_OUTPUT%" "%OUT%" >nul',
  'exit /b 0',
].join('\r\n'), 'utf8');

const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
const originalPath = process.env[pathKey];
process.env[pathKey] = bin + path.delimiter + originalPath;
process.env.PET_OFFICE_PROMPT_CAPTURE = capturePath;
process.env.PET_OFFICE_ARGS_CAPTURE = argsPath;
process.env.PET_OFFICE_CWD_CAPTURE = cwdPath;
process.env.PET_OFFICE_FAKE_OUTPUT = fakeOutputPath;
process.env.PET_OFFICE_FORCE_OPENCODEX_HTTP = '1';

function writeFakeOutput(value) {
  fs.writeFileSync(fakeOutputPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function readCapture() {
  return fs.readFileSync(capturePath, 'utf8').replace(/\r\n/g, '\n');
}

async function testNewMissionPrompt() {
  writeFakeOutput({
    objective: '完整目标',
    assumptions: [],
    tasks: [{
      id: 'work', title: '执行', brief: '完成目标', assigneePetId: 'worker-1', fallbackAssignee: null,
      fallbackModel: null, dependsOn: [], mode: 'write', fileScopes: ['src/**/*'], deliverables: ['结果'],
      validation: ['检查结果'], required: true,
    }],
  });
  const result = await planner.planMission({
    projectDir: project,
    missionDir,
    objective: 'OBJECTIVE-LINE-1\nOBJECTIVE-LINE-2\nOBJECTIVE-LINE-3',
    participants: [{ petId: 'worker-1', name: '成员一', model: 'test-model', fallbackModel: null }],
    supervisorModel: null,
    threadId: null,
  });
  assert(result.ok, result.error);
  assert.equal(result.threadId, 'pipe-test-thread');
  const prompt = readCapture();
  assert(prompt.includes('OBJECTIVE-LINE-1\nOBJECTIVE-LINE-2\nOBJECTIVE-LINE-3'));
  assert(prompt.includes('Return only the JSON object required by the output schema.'));
  const args = fs.readFileSync(argsPath, 'utf8');
  assert(!args.includes('OBJECTIVE-LINE-1'));
  assert.match(args, /(?:^|\s)-(?:\s|$)/);
  assert(args.includes('supports_websockets=false'));
}

async function testResumedMissionPrompt() {
  writeFakeOutput({ ok: true });
  const result = await planner.runStructured({
    projectDir: project,
    missionDir,
    kind: 'resume-probe',
    prompt: '# RESUME-PROMPT\nRESUME-LINE-2\nRESUME-LINE-3',
    schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
    threadId: 'existing-thread-id',
  });
  assert(result.ok, result.error);
  assert(readCapture().includes('# RESUME-PROMPT\nRESUME-LINE-2\nRESUME-LINE-3'));
  const args = fs.readFileSync(argsPath, 'utf8');
  assert(args.includes('resume'));
  assert(args.includes('existing-thread-id'));
  assert(args.includes('--skip-git-repo-check'));
  assert(args.includes('sandbox_mode=read-only'));
  assert.equal(path.resolve(fs.readFileSync(cwdPath, 'utf8').trim()).toLowerCase(), path.resolve(project).toLowerCase());
}

async function testBusySupervisorFallsBackToFreshThread() {
  writeFakeOutput({ ok: true });
  process.env.PET_OFFICE_FAIL_RESUME = '1';
  process.env.PET_OFFICE_FAIL_MARKER = path.join(root, 'resume-failed-once.txt');
  try {
    const result = await planner.runSupervisorStructured({
      projectDir: project,
      missionDir,
      kind: 'busy-resume-probe',
      prompt: '# BUSY-THREAD\nCREATE-A-FRESH-SUPERVISOR',
      schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
      threadId: 'busy-thread-id',
    });
    assert(result.ok, result.error);
    assert.equal(result.threadId, 'pipe-test-thread');
    assert(readCapture().includes('# BUSY-THREAD\nCREATE-A-FRESH-SUPERVISOR'));
    assert(!/\bexec\s+resume\b/i.test(fs.readFileSync(argsPath, 'utf8')), 'fallback invocation must create a fresh supervisor thread');
  } finally {
    delete process.env.PET_OFFICE_FAIL_RESUME;
    delete process.env.PET_OFFICE_FAIL_MARKER;
  }
}

async function testWorkerPrompt() {
  writeFakeOutput('worker complete');
  const done = new Promise((resolve, reject) => {
    dispatcher.setEmitter(event => {
      if (event.taskId !== 'worker-pipe') return;
      if (event.type === 'done') resolve(event);
      if (event.type === 'failed') reject(new Error(event.error || ('worker exit ' + event.exitCode)));
    });
  });
  dispatcher.setConcurrency(1);
  dispatcher.startTask({
    id: 'worker-pipe', projectDir: project, skipLegacyDirs: true,
    briefPath: path.join(project, 'worker.brief.md'), resultPath: path.join(project, 'worker.result.md'),
    brief: '测试工作者提示词', prompt: '# WORKER-PROMPT\nWORKER-LINE-2\nWORKER-LINE-3',
  });
  await done;
  assert(readCapture().includes('# WORKER-PROMPT\nWORKER-LINE-2\nWORKER-LINE-3'));
  assert.equal(fs.readFileSync(path.join(project, 'worker.result.md'), 'utf8'), 'worker complete');
}

(async () => {
  try {
    await testNewMissionPrompt();
    await testResumedMissionPrompt();
    await testBusySupervisorFallsBackToFreshThread();
    await testWorkerPrompt();
    console.log('prompt pipe tests passed');
  } finally {
    dispatcher.shutdown();
    process.env[pathKey] = originalPath;
    delete process.env.PET_OFFICE_PROMPT_CAPTURE;
    delete process.env.PET_OFFICE_ARGS_CAPTURE;
    delete process.env.PET_OFFICE_CWD_CAPTURE;
    delete process.env.PET_OFFICE_FAKE_OUTPUT;
    delete process.env.PET_OFFICE_FORCE_OPENCODEX_HTTP;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
