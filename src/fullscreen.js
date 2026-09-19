'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DIRS } = require('./config');

const SCRIPT = path.join(DIRS.bin, 'is-fullscreen.ps1');
const SCRIPT_BODY = [
  'param([int]$OwnPid = 0)',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class U {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
  '  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();',
  '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '}',
  '"@',
  '$h = [U]::GetForegroundWindow()',
  'if ($h -eq [IntPtr]::Zero) { \'{"fullscreen":false}\'; exit }',
  '$procId = 0',
  '[void][U]::GetWindowThreadProcessId($h, [ref]$procId)',
  'if ($OwnPid -gt 0 -and $procId -eq $OwnPid) { \'{"fullscreen":false}\'; exit }',
  'if ($h -eq [U]::GetShellWindow()) { \'{"fullscreen":false}\'; exit }',
  '$r = New-Object "U+RECT"',
  '[void][U]::GetWindowRect($h, [ref]$r)',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
  '$full = ($r.Left -le $b.X + 2 -and $r.Top -le $b.Y + 2 -and $r.Right -ge $b.Right - 2 -and $r.Bottom -ge $b.Bottom - 2)',
  '\'{"fullscreen":\' + $full.ToString().ToLower() + \'}\'',
].join('\n');

function startPolling(onChange, intervalMs = 3000, ownPid = 0) {
  try {
    fs.mkdirSync(DIRS.bin, { recursive: true });
    fs.writeFileSync(SCRIPT, SCRIPT_BODY, 'utf8');
  } catch (e) { return; }
  let last = false;
  const tick = () => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-OwnPid', String(ownPid)], { windowsHide: true });
    } catch { return; }
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.on('exit', () => {
      try {
        const line = out.trim().split(/\r?\n/).pop();
        const v = JSON.parse(line).fullscreen;
        if (v !== last) { last = v; onChange(v); }
      } catch {}
    });
  };
  setInterval(tick, intervalMs);
  tick();
}

module.exports = { startPolling };
