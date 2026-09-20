'use strict';

const { spawn } = require('child_process');

function isFullscreenBounds(rect, displayBounds, tolerance = 3) {
  if (!rect || !displayBounds) return false;
  return Math.abs(rect.x - displayBounds.x) <= tolerance
    && Math.abs(rect.y - displayBounds.y) <= tolerance
    && Math.abs(rect.width - displayBounds.width) <= tolerance
    && Math.abs(rect.height - displayBounds.height) <= tolerance;
}

function probeForegroundWindow(timeoutMs = 3500) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const source = `
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
$h=[PetOfficeWin32]::GetForegroundWindow(); if($h -eq [IntPtr]::Zero){ exit }
$r=New-Object PetOfficeWin32+RECT; [void][PetOfficeWin32]::GetWindowRect($h,[ref]$r)
$pidValue=0; [void][PetOfficeWin32]::GetWindowThreadProcessId($h,[ref]$pidValue)
$c=New-Object System.Text.StringBuilder 128; [void][PetOfficeWin32]::GetClassName($h,$c,128)
[pscustomobject]@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top;pid=$pidValue;class=$c.ToString()} | ConvertTo-Json -Compress
`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise(resolve => {
    let child;
    try { child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let output = '';
    child.stdout.on('data', data => { output += data.toString(); });
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.on('error', () => finish(null));
    child.on('exit', () => { try { finish(JSON.parse(output.trim())); } catch { finish(null); } });
  });
}

module.exports = { isFullscreenBounds, probeForegroundWindow };
