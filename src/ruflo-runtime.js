'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const RUFLO_VERSION = '3.43.0';
const RUFLO_CLI_VERSION = '3.43.0';
const MCP_PROTOCOL = '2024-11-05';
const MCP_TOOLS = 'swarm,agent,task,memory,coordination,hooks_route';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const REQUIRED_TOOLS = [
  'swarm_init', 'swarm_status', 'swarm_health', 'swarm_shutdown',
  'agent_spawn', 'agent_status', 'agent_list', 'agent_update', 'agent_terminate',
  'task_create', 'task_status', 'task_list', 'task_update', 'task_assign',
  'task_cancel', 'task_retry', 'task_complete', 'memory_store', 'memory_search',
];

function safeSegment(value) {
  const plain = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 54) || 'project';
  const hash = crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
  return plain + '-' + hash;
}

function parseVersion(value) {
  const match = String(value || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(value, major, minor) {
  const parsed = parseVersion(value);
  return !!parsed && (parsed[0] > major || (parsed[0] === major && parsed[1] >= minor));
}

function checksRuntimeInstalled(versions) {
  return !!versions && versions.ruflo === RUFLO_VERSION && versions.cli === RUFLO_CLI_VERSION;
}

function redact(value) {
  return String(value == null ? '' : value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(api[_ -]?key|token|password|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
}

function commandVersion(command, args) {
  const useCmd = process.platform === 'win32' && /\.cmd$/i.test(command);
  const result = spawnSync(useCmd ? (process.env.ComSpec || 'cmd.exe') : command, useCmd ? ['/d', '/s', '/c', command, ...args] : args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { ok: result.status === 0, version: String(result.stdout || result.stderr || '').trim(), error: result.error && result.error.message };
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return finish({ ok: false, code: -1, error: error.message, stdout: '', stderr: '' });
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-16000);
      if (options.onProgress) options.onProgress(redact(String(chunk)).trim());
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-16000);
      if (options.onProgress) options.onProgress(redact(String(chunk)).trim());
    });
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); } catch {}
      } else {
        try { child.kill('SIGTERM'); } catch {}
      }
      finish({ ok: false, code: -1, error: '操作超时', stdout, stderr });
    }, options.timeoutMs || 300000);
    child.on('error', error => { clearTimeout(timer); finish({ ok: false, code: -1, error: error.message, stdout, stderr }); });
    child.on('exit', code => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, error: code === 0 ? null : redact(stderr || stdout || ('exit ' + code)), stdout, stderr });
    });
  });
}

function runNpm(args, options = {}) {
  if (process.platform === 'win32') {
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
  }
  return run('npm', args, options);
}

class RufloMcpClient {
  constructor({ command, args, cwd, env, log = () => {}, onExit = () => {} }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.log = log;
    this.onExit = onExit;
    this.child = null;
    this.buffer = '';
    this.sequence = 0;
    this.pending = new Map();
    this.tools = [];
    this.starting = null;
    this.intentional = false;
  }

  async start() {
    if (this.child && !this.child.killed && this.tools.length) return this;
    if (this.starting) return this.starting;
    this.starting = this._start().catch(error => {
      this.stop();
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    this.intentional = false;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this._read(chunk));
    this.child.stderr.on('data', chunk => this.log('ruflo mcp: ' + redact(String(chunk)).trim().slice(0, 1000)));
    this.child.on('error', error => this._failAll(error));
    this.child.on('exit', code => {
      const error = new Error('Ruflo MCP 已退出（code ' + code + '）');
      this._failAll(error);
      this.child = null;
      this.tools = [];
      if (!this.intentional) this.onExit(error);
    });
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'pet-office', version: '0.15.0' },
    }, 120000);
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {}, 120000);
    this.tools = listed.tools || [];
    const names = new Set(this.tools.map(tool => tool.name));
    const missing = REQUIRED_TOOLS.filter(name => !names.has(name));
    if (missing.length) throw new Error('Ruflo MCP 缺少核心能力：' + missing.join(', '));
    return this;
  }

  _read(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id == null || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Ruflo MCP 调用失败'));
      else pending.resolve(message.result);
    }
  }

  _failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) return reject(new Error('Ruflo MCP 未连接'));
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Ruflo MCP 调用超时：' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async call(name, args = {}) {
    await this.start();
    const timeoutMs = name.startsWith('memory_') ? 300000 : 90000;
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = result && result.content && result.content.find(item => item.type === 'text');
    if (!text) return result;
    try { return JSON.parse(text.text); } catch { return { success: !result.isError, text: text.text }; }
  }

  stop() {
    this.intentional = true;
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.tools = [];
  }
}

class RufloRuntimeManager {
  constructor({ root, log = () => {}, onStatus = () => {} }) {
    this.root = root;
    this.runtimeDir = path.join(root, 'runtime');
    this.projectsDir = path.join(root, 'projects');
    this.logsDir = path.join(root, 'logs');
    this.binDir = path.join(root, 'bin');
    this.log = log;
    this.onStatus = onStatus;
    this.clients = new Map();
    this.restarts = new Map();
    this.status = { state: 'unknown', version: RUFLO_VERSION, cliVersion: RUFLO_CLI_VERSION, checkedAt: 0 };
  }

  ensureDirs() {
    for (const dir of [this.root, this.runtimeDir, this.projectsDir, this.logsDir, this.binDir]) fs.mkdirSync(dir, { recursive: true });
  }

  manifestPath() { return path.join(this.runtimeDir, 'package.json'); }
  entryPath() { return path.join(this.runtimeDir, 'node_modules', 'ruflo', 'bin', 'ruflo.js'); }
  cliPackagePath() { return path.join(this.runtimeDir, 'node_modules', '@claude-flow', 'cli', 'package.json'); }
  wrapperPath() { return path.join(this.binDir, 'ruflo-mcp.mjs'); }

  projectDir(projectId) {
    const dir = path.join(this.projectsDir, safeSegment(projectId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeControlledFiles() {
    this.ensureDirs();
    const manifest = {
      name: 'pet-office-ruflo-runtime', private: true, version: '0.15.0',
      dependencies: { ruflo: RUFLO_VERSION, '@claude-flow/cli': RUFLO_CLI_VERSION },
      overrides: { ruflo: { '@claude-flow/cli': RUFLO_CLI_VERSION } },
    };
    fs.writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    const entryUrl = pathToFileURL(this.entryPath()).href;
    const huggingFaceEnvUrl = pathToFileURL(path.join(this.runtimeDir, 'node_modules', '@huggingface', 'transformers', 'src', 'env.js')).href;
    const xenovaEnvUrl = pathToFileURL(path.join(this.runtimeDir, 'node_modules', '@xenova', 'transformers', 'src', 'env.js')).href;
    const wrapper = [
      "import process from 'node:process';",
      "const cwd = process.env.PET_OFFICE_RUFLO_CWD;",
      "if (!cwd) throw new Error('PET_OFFICE_RUFLO_CWD is required');",
      'process.chdir(cwd);',
      '// Memory calls must never start an unannounced Hugging Face download.',
      '// Cached ONNX assets remain usable; otherwise Ruflo falls through to its',
      '// bundled local embedder or deterministic offline fallback.',
      `for (const url of ${JSON.stringify([huggingFaceEnvUrl, xenovaEnvUrl])}) {`,
      "  try { const mod = await import(url); if (mod.env) mod.env.allowRemoteModels = false; } catch {}",
      '}',
      "const nativeFetch = globalThis.fetch && globalThis.fetch.bind(globalThis);",
      'if (nativeFetch) globalThis.fetch = (input, init) => {',
      "  const target = String(input && input.url ? input.url : input);",
      "  if (/^https:\\/\\/(?:www\\.)?huggingface\\.co\\//i.test(target)) throw new Error('Pet Office blocks implicit embedding-model downloads');",
      '  return nativeFetch(input, init);',
      '};',
      `await import(${JSON.stringify(entryUrl)});`,
      '',
    ].join('\n');
    fs.writeFileSync(this.wrapperPath(), wrapper, 'utf8');
  }

  installedVersions() {
    try {
      const ruflo = JSON.parse(fs.readFileSync(path.join(this.runtimeDir, 'node_modules', 'ruflo', 'package.json'), 'utf8')).version;
      const cli = JSON.parse(fs.readFileSync(this.cliPackagePath(), 'utf8')).version;
      return { ruflo, cli };
    } catch { return { ruflo: null, cli: null }; }
  }

  async health(projectId = null, { probe = false } = {}) {
    this.ensureDirs();
    const node = commandVersion('node.exe', ['--version']);
    const npm = commandVersion('npm.cmd', ['--version']);
    const versions = this.installedVersions();
    let freeBytes = null;
    try { freeBytes = fs.statfsSync(this.root).bavail * fs.statfsSync(this.root).bsize; } catch {}
    const checks = {
      node: { ok: node.ok && atLeast(node.version, 20, 0), value: node.version || node.error || '未找到', required: '>=20' },
      npm: { ok: npm.ok && atLeast(npm.version, 9, 0), value: npm.version || npm.error || '未找到', required: '>=9' },
      network: { ok: checksRuntimeInstalled(versions), value: checksRuntimeInstalled(versions) ? '运行时已缓存' : '尚未检查 npm registry' },
      disk: { ok: freeBytes == null || freeBytes >= 1024 * 1024 * 1024, value: freeBytes },
      runtime: { ok: versions.ruflo === RUFLO_VERSION && versions.cli === RUFLO_CLI_VERSION, value: versions },
      mcp: { ok: false, value: null },
    };
    if (checks.runtime.ok && probe && projectId) {
      try {
        const client = await this.client(projectId);
        checks.mcp = { ok: true, value: { tools: client.tools.length, required: REQUIRED_TOOLS.length } };
      } catch (error) { checks.mcp = { ok: false, value: redact(error.message) }; }
    } else if (checks.runtime.ok) checks.mcp = { ok: true, value: '安装后将在创建任务时验证' };
    if (!checks.runtime.ok && probe && checks.npm.ok) {
      const network = await runNpm(['view', 'ruflo@' + RUFLO_VERSION, 'version', '--json', '--registry', NPM_REGISTRY], { cwd: this.runtimeDir, timeoutMs: 20000 });
      checks.network = { ok: network.ok && network.stdout.includes(RUFLO_VERSION), value: network.ok ? 'npm registry 可访问' : (network.error || '无法访问 npm registry') };
    }
    const ready = checks.node.ok && checks.npm.ok && checks.network.ok && checks.disk.ok && checks.runtime.ok && checks.mcp.ok;
    this.status = { state: ready ? 'ready' : 'setup_required', ready, version: RUFLO_VERSION, cliVersion: RUFLO_CLI_VERSION, checks, checkedAt: Date.now() };
    this.onStatus(this.status);
    return this.status;
  }

  async install({ onProgress = () => {}, force = false } = {}) {
    this.shutdown();
    this.writeControlledFiles();
    if (!force && checksRuntimeInstalled(this.installedVersions()) && fs.existsSync(this.entryPath())) {
      onProgress('已找到精确版本 Ruflo 运行时，正在执行 MCP 健康检查…');
      const cachedHealth = await this.health('installation-check', { probe: true });
      if (cachedHealth.ready) return cachedHealth;
      onProgress('缓存运行时健康检查未通过，正在重新安装…');
      this.shutdown();
    }
    onProgress('正在安装固定版 Ruflo 3.43.0…');
    const result = await runNpm(['install', '--no-audit', '--no-fund', '--save-exact', '--registry', NPM_REGISTRY], {
      cwd: this.runtimeDir, timeoutMs: 600000, onProgress,
    });
    if (!result.ok) throw new Error('Ruflo 安装失败：' + (result.error || 'npm install failed'));
    this.writeControlledFiles();
    const health = await this.health('installation-check', { probe: true });
    if (!health.ready) throw new Error('Ruflo 已安装，但 MCP 健康检查未通过。');
    return health;
  }

  async repair({ onProgress = () => {} } = {}) {
    onProgress('正在重新校验并修复 Ruflo 运行时…');
    return this.install({ onProgress, force: true });
  }

  mcpLaunch(projectId) {
    this.writeControlledFiles();
    const cwd = this.projectDir(projectId);
    return {
      command: 'node.exe',
      args: [this.wrapperPath(), 'mcp', 'start'],
      cwd,
      env: {
        ...process.env,
        PET_OFFICE_RUFLO_CWD: cwd,
        PET_OFFICE_RUFLO_PROJECT_ID: String(projectId),
        RUVECTOR_CACHE_DIR: path.join(this.root, 'models'),
        CLAUDE_FLOW_MCP_TOOLS: MCP_TOOLS,
      },
    };
  }

  workerMcpConfig(projectId, missionId, taskId) {
    const launch = this.mcpLaunch(projectId);
    return {
      command: launch.command,
      args: launch.args,
      env: {
        PET_OFFICE_RUFLO_CWD: launch.cwd,
        PET_OFFICE_RUFLO_PROJECT_ID: String(projectId),
        PET_OFFICE_MISSION_ID: String(missionId),
        PET_OFFICE_RUFLO_TASK_ID: String(taskId),
        RUVECTOR_CACHE_DIR: path.join(this.root, 'models'),
        CLAUDE_FLOW_MCP_TOOLS: MCP_TOOLS,
      },
    };
  }

  async client(projectId) {
    const key = String(projectId);
    let client = this.clients.get(key);
    if (!client) {
      const launch = this.mcpLaunch(key);
      client = new RufloMcpClient({
        ...launch,
        log: this.log,
        onExit: error => this.scheduleRestart(key, error),
      });
      this.clients.set(key, client);
    }
    await client.start();
    this.restarts.set(key, 0);
    return client;
  }

  scheduleRestart(projectId, error) {
    const attempt = Math.min((this.restarts.get(projectId) || 0) + 1, 6);
    this.restarts.set(projectId, attempt);
    const delay = Math.min(30000, 1000 * (2 ** (attempt - 1)));
    this.log('ruflo mcp restart ' + projectId + ' in ' + delay + 'ms: ' + redact(error.message));
    this.onStatus({ ...this.status, state: 'reconnecting', ready: false, projectId, retryInMs: delay, error: redact(error.message) });
    setTimeout(() => this.client(projectId).catch(next => this.scheduleRestart(projectId, next)), delay).unref();
  }

  shutdown() {
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
  }
}

module.exports = {
  RufloRuntimeManager, RufloMcpClient, RUFLO_VERSION, RUFLO_CLI_VERSION,
  REQUIRED_TOOLS, MCP_TOOLS, safeSegment, redact, _internals: { parseVersion, atLeast, commandVersion },
};
