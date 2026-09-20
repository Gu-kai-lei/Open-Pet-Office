'use strict';

// Codex App Server 客户端：通过 stdio 上的 JSON-RPC 与 codex app-server 通信，
// 让桌宠使用与 Codex 桌面端相同线程模型（thread / turn / item 事件）。
const { spawn } = require('child_process');
const cfg = require('./config');

// Codex Desktop only shows locally-created conversations in its normal task list
// when they carry the desktop client's originator. Pet Office behaves as a
// desktop companion, so new supervisor conversations use the same originator.
const CLIENT_INFO = { name: 'Codex Desktop', title: 'Pet Office', version: '0.10.1' };

class AppServerClient {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.readyPromise = null;
    this.closed = false;
    this.lastError = null;
    this.lastStartedAt = 0;
    this.defaultTimeoutMs = 30000;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { cfg.log('appserver listener failed: ' + error.message); }
    }
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    this.closed = false;
    this.lastStartedAt = Date.now();
    this.readyPromise = new Promise((resolve, reject) => {
      const command = process.platform === 'win32' ? 'cmd.exe' : 'codex';
      const args = process.platform === 'win32'
        ? ['/c', 'codex', 'app-server', '--listen', 'stdio://']
        : ['app-server', '--listen', 'stdio://'];
      try {
        this.child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      } catch (error) {
        reject(error);
        return;
      }
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', chunk => this.consume(chunk));
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', chunk => {
        const text = String(chunk).trim();
        if (text) {
          this.lastError = text.slice(0, 600);
          cfg.log('app-server stderr: ' + text.slice(0, 400));
        }
      });
      this.child.on('exit', code => {
        cfg.log('app-server exited: ' + code);
        this.child = null;
        this.readyPromise = null;
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('app-server exited: ' + code));
        }
        this.pending.clear();
        this.emit({ type: 'closed', code });
      });
      this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null }, 20000)
        .then(() => {
          this.notify('initialized', {});
          resolve(this);
        })
        .catch(error => {
          this.lastError = error.message;
          const child = this.child;
          this.child = null;
          this.readyPromise = null;
          try { if (child) child.kill(); } catch {}
          reject(error);
        });
    });
    return this.readyPromise;
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.handle(message);
    }
  }

  handle(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const entry = this.pending.get(message.id);
      if (entry) {
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      // 审批和需要用户回答的问题交给主进程展示；主进程随后通过
      // respondToServerRequest() 返回符合协议的结果。
      this.emit({ type: 'server-request', method: message.method, params: message.params, id: message.id });
      return;
    }
    if (message.method) this.emit({ type: 'notification', method: message.method, params: message.params });
  }

  deniedResponse(method) {
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      return { decision: { denied: { rejection: 'Pet Office 未获得用户批准；请在 Codex 中继续并确认。' } } };
    }
    if (method === 'item/permissions/requestApproval') return { permissions: {} };
    return { decision: 'decline' };
  }

  respondToServerRequest(id, result) {
    this.reply(id, result);
  }

  reply(id, result) {
    try { this.child.stdin.write(JSON.stringify({ id, result }) + '\n'); } catch {}
  }

  request(method, params, timeoutMs = this.defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(method + ' 请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）');
        this.lastError = error.message;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    try { this.child.stdin.write(JSON.stringify({ method, params: params || {} }) + '\n'); } catch {}
  }

  async startThread({ cwd, model, sandbox = 'workspace-write', approvalPolicy = 'never' }) {
    await this.start();
    const result = await this.request('thread/start', {
      cwd: cwd || process.cwd(),
      model: model || null,
      sandbox,
      approvalPolicy,
      ephemeral: false,
      serviceName: 'pet-office',
      config: null,
    });
    const threadId = (result && (result.threadId || (result.thread && result.thread.id))) || null;
    cfg.log('app-server thread/start -> ' + threadId);
    return { threadId, result };
  }

  async startTurn({ threadId, text, model }) {
    await this.start();
    const result = await this.request('turn/start', {
      threadId,
      model: model || null,
      input: [{ type: 'text', text: String(text || '') }],
    }, 60000);
    cfg.log('app-server turn/start -> ' + JSON.stringify(result).slice(0, 200));
    return result;
  }

  async resumeThread({ threadId, cwd, model }) {
    await this.start();
    return this.request('thread/resume', {
      threadId, cwd, model: model || null,
      sandbox: 'workspace-write', approvalPolicy: 'on-request',
    });
  }

  async setThreadName({ threadId, name }) {
    await this.start();
    return this.request('thread/name/set', { threadId, name: String(name || '').trim().slice(0, 80) });
  }

  async unsubscribeThread({ threadId }) {
    if (!this.child || !this.readyPromise) return {};
    return this.request('thread/unsubscribe', { threadId });
  }

  async interruptTurn({ threadId, turnId }) {
    await this.start();
    return this.request('turn/interrupt', { threadId, turnId });
  }

  async listThreads(limit = 20) {
    await this.start();
    return this.request('thread/list', { limit });
  }

  stop() {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('app-server stopped'));
    }
    this.pending.clear();
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      try { this.child.kill(); } catch {}
    }
    this.child = null;
    this.readyPromise = null;
  }

  health() {
    return {
      running: !!this.child,
      pendingRequests: this.pending.size,
      lastStartedAt: this.lastStartedAt || null,
      lastError: this.lastError,
    };
  }
}

module.exports = { AppServerClient };
