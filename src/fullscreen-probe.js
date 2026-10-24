'use strict';

const { spawn } = require('child_process');

function isFullscreenBounds(rect, displayBounds, tolerance = 3) {
  if (!rect || !displayBounds) return false;
  return Math.abs(rect.x - displayBounds.x) <= tolerance
    && Math.abs(rect.y - displayBounds.y) <= tolerance
    && Math.abs(rect.width - displayBounds.width) <= tolerance
    && Math.abs(rect.height - displayBounds.height) <= tolerance;
}

// Starting PowerShell and compiling the Win32 shim costs ~0.5 s per call. The
// app probes every few seconds for its whole lifetime, so one long-lived
// process compiles once and answers each request line with one JSON line.
const PROBE_LOOP = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PetOfficeWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $h=[PetOfficeWin32]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { $json = 'null' } else {
      $r=New-Object PetOfficeWin32+RECT; [void][PetOfficeWin32]::GetWindowRect($h,[ref]$r)
      $pidValue=0; [void][PetOfficeWin32]::GetWindowThreadProcessId($h,[ref]$pidValue)
      $c=New-Object System.Text.StringBuilder 128; [void][PetOfficeWin32]::GetClassName($h,$c,128)
      $json = [pscustomobject]@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top;pid=$pidValue;class=$c.ToString()} | ConvertTo-Json -Compress
    }
  } catch { $json = 'null' }
  [Console]::Out.WriteLine($json); [Console]::Out.Flush()
}
`;

class ForegroundProbe {
  constructor({ spawnImpl = spawn, startupTimeoutMs = 10000 } = {}) {
    this.spawn = spawnImpl;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.buffer = '';
    this.ready = null;
    this.waiters = [];
    this.failures = 0;
    this.retryAt = 0;
  }

  start() {
    if (this.ready) return this.ready;
    if (Date.now() < this.retryAt) return Promise.resolve(false);
    const encoded = Buffer.from(PROBE_LOOP, 'utf16le').toString('base64');
    let child;
    try {
      child = this.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return this.fail(null); }
    this.child = child;
    this.buffer = '';
    this.ready = new Promise(resolve => {
      const timer = setTimeout(() => { this.fail(child); resolve(false); }, this.startupTimeoutMs);
      this.onReady = ok => { clearTimeout(timer); resolve(ok); };
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.read(child, chunk));
    child.on('error', () => this.fail(child));
    child.on('exit', () => this.fail(child));
    if (child.stdin.on) child.stdin.on('error', () => this.fail(child));
    return this.ready;
  }

  read(child, chunk) {
    if (child !== this.child) return;
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === 'ready') {
        this.failures = 0;
        if (this.onReady) this.onReady(true);
        this.onReady = null;
        continue;
      }
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      let value = null;
      try { value = JSON.parse(line); } catch {}
      waiter(value);
    }
  }

  // A dead or wedged helper is replaced on a later probe, with backoff so a
  // machine that blocks PowerShell is not hammered with launches.
  fail(child) {
    if (child && child !== this.child) return false;
    const current = this.child;
    this.child = null;
    this.ready = null;
    if (this.onReady) this.onReady(false);
    this.onReady = null;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    this.failures++;
    this.retryAt = Date.now() + Math.min(5 * 60 * 1000, 2000 * (2 ** Math.min(this.failures, 7)));
    if (current) { try { current.kill(); } catch {} }
    return false;
  }

  async probe(timeoutMs = 3500) {
    if (!(await this.start()) || !this.child) return null;
    const child = this.child;
    return new Promise(resolve => {
      let settled = false;
      const done = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => {
        const position = this.waiters.indexOf(done);
        if (position >= 0) this.waiters.splice(position, 1);
        this.fail(child);
        done(null);
      }, timeoutMs);
      this.waiters.push(done);
      try { child.stdin.write('probe\n'); } catch { this.fail(child); }
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    if (child) {
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    }
  }
}

let sharedProbe = null;

function probeForegroundWindow(timeoutMs = 3500) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!sharedProbe) sharedProbe = new ForegroundProbe();
  return sharedProbe.probe(timeoutMs);
}

function stopForegroundProbe() {
  if (sharedProbe) sharedProbe.stop();
  sharedProbe = null;
}

module.exports = { isFullscreenBounds, probeForegroundWindow, stopForegroundProbe, ForegroundProbe };
