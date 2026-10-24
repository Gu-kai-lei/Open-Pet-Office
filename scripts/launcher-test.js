'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { codexLaunch, codexCommand, resetCodexLaunchCache } = require('../src/codex-launcher');

if (process.platform !== 'win32') {
  assert.deepEqual(codexLaunch(), { command: 'codex', args: [], kind: 'path' });
  console.log('launcher tests skipped (Windows only)');
  process.exit(0);
}

// The exact shim npm writes for global packages (see %APPDATA%\npm\codex.cmd).
const NPM_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet office & launcher ^test-'));
try {
  const nodeDir = path.dirname(process.execPath);
  const shimDir = path.join(root, 'npm');
  const entry = path.join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'codex.cmd'), NPM_SHIM);
  fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const env = { PATH: [shimDir, nodeDir].join(path.delimiter), PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  resetCodexLaunchCache();
  const shim = codexLaunch({ env });
  assert.equal(shim.kind, 'npm-shim');
  assert.equal(shim.command.toLowerCase(), path.join(nodeDir, 'node.exe').toLowerCase());
  assert.deepEqual(shim.args, [entry]);

  // Arguments that cmd.exe would reinterpret now arrive unchanged.
  const tricky = ['exec', '-m', 'vendor/model&calc', 'C:\\Users\\a b\\proj^1', '100%PATH%', 'pipe|more', 'line one\nline two', 'say "hi"'];
  const launch = codexCommand(tricky, { env });
  const result = spawnSync(launch.command, launch.args, { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), tricky);

  // A bundled node.exe next to the shim wins, as in the shim itself.
  fs.copyFileSync(process.execPath, path.join(shimDir, 'node.exe'));
  resetCodexLaunchCache();
  assert.equal(codexLaunch({ env }).command, path.join(shimDir, 'node.exe'));
  fs.rmSync(path.join(shimDir, 'node.exe'));

  // cmd.exe order: earlier PATH directory first, then PATHEXT within a directory.
  const exeDir = path.join(root, 'exe');
  fs.mkdirSync(exeDir);
  fs.copyFileSync(process.execPath, path.join(exeDir, 'codex.exe'));
  fs.writeFileSync(path.join(exeDir, 'codex.cmd'), '@echo off\r\n');
  assert.equal(codexLaunch({ env: { ...env, PATH: [exeDir, shimDir, nodeDir].join(path.delimiter) } }).kind, 'exe');
  assert.equal(codexLaunch({ env: { ...env, PATH: [shimDir, exeDir, nodeDir].join(path.delimiter) } }).kind, 'npm-shim', 'cache follows PATH changes');

  // Unknown batch launchers keep working through the previous cmd.exe path.
  const customDir = path.join(root, 'custom');
  fs.mkdirSync(customDir);
  fs.writeFileSync(path.join(customDir, 'codex.cmd'), '@echo off\r\necho custom\r\n');
  const fallback = codexLaunch({ env: { ...env, PATH: [customDir, nodeDir].join(path.delimiter), ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  assert.equal(fallback.kind, 'cmd-fallback');
  assert.deepEqual(fallback.args, ['/d', '/s', '/c', 'codex']);

  // An explicit override is honoured for portable or side-by-side installs.
  const override = codexLaunch({ env: { ...env, PATH: nodeDir, PET_OFFICE_CODEX_PATH: entry } });
  assert.equal(override.kind, 'override-node');
  assert.deepEqual(override.args, [entry]);

  console.log('launcher: npm shim resolution, verbatim arguments, PATH order, fallback and override OK');
} finally {
  resetCodexLaunchCache();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
