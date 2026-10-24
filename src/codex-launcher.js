'use strict';

// Resolves how to start Codex without routing arguments through cmd.exe.
// cmd.exe re-parses every argument: newlines truncate prompts and characters
// such as & | ^ % in paths or model names become shell syntax. Spawning the
// real executable (or the npm shim's Node entry) passes arguments verbatim.
const fs = require('fs');
const path = require('path');

const NPM_SHIM_ENTRY = /"%(?:~?dp0)%\\?([^"%]+?\.(?:c|m)?js)"\s+%\*/i;

let cache = { key: null, launch: null };

function envValue(env, name) {
  const key = Object.keys(env).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function findOnPath(names, env) {
  const dirs = String(envValue(env, 'PATH') || '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g, '').trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

// npm writes the same cmd shim for every global package. Reading its target
// lets us run `node <entry>` directly, exactly what the shim would do.
function npmShimTarget(shim, env) {
  let text;
  try { text = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  const match = text.match(NPM_SHIM_ENTRY);
  if (!match) return null;
  const dir = path.dirname(shim);
  const script = path.resolve(dir, match[1].replace(/\//g, '\\'));
  if (!isFile(script)) return null;
  const bundledNode = path.join(dir, 'node.exe');
  const node = isFile(bundledNode) ? bundledNode : findOnPath(['node.exe'], env);
  return node ? { command: node, args: [script] } : null;
}

function resolveWindows(env) {
  const override = envValue(env, 'PET_OFFICE_CODEX_PATH');
  if (override && isFile(override)) {
    if (/\.(?:c|m)?js$/i.test(override)) {
      const node = findOnPath(['node.exe'], env);
      if (node) return { command: node, args: [path.resolve(override)], kind: 'override-node' };
    } else if (/\.(?:exe|com)$/i.test(override)) return { command: path.resolve(override), args: [], kind: 'override-exe' };
    else if (/\.(?:cmd|bat)$/i.test(override)) {
      const target = npmShimTarget(override, env);
      if (target) return { ...target, kind: 'override-npm-shim' };
    }
  }
  // Follow cmd.exe's lookup order: PATH directories first, then PATHEXT.
  const extensions = String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean);
  const names = extensions.filter(ext => ['.com', '.exe', '.bat', '.cmd'].includes(ext)).map(ext => 'codex' + ext);
  const found = findOnPath(names, env);
  if (found && /\.(?:exe|com)$/i.test(found)) return { command: found, args: [], kind: 'exe' };
  if (found) {
    const target = npmShimTarget(found, env);
    if (target) return { ...target, kind: 'npm-shim' };
  }
  // Unknown launcher (custom batch file, missing install): keep the previous
  // behaviour so Codex still starts; callers already pipe prompts via stdin.
  return { command: envValue(env, 'ComSpec') || 'cmd.exe', args: ['/d', '/s', '/c', 'codex'], kind: 'cmd-fallback' };
}

function codexLaunch({ env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return { command: 'codex', args: [], kind: 'path' };
  const key = [envValue(env, 'PATH'), envValue(env, 'PATHEXT'), envValue(env, 'PET_OFFICE_CODEX_PATH')].join('\u0000');
  if (cache.key !== key) cache = { key, launch: resolveWindows(env) };
  return cache.launch;
}

function codexCommand(args, options) {
  const launch = codexLaunch(options);
  return { command: launch.command, args: [...launch.args, ...args], kind: launch.kind };
}

function resetCodexLaunchCache() { cache = { key: null, launch: null }; }

module.exports = { codexLaunch, codexCommand, resetCodexLaunchCache, _internals: { npmShimTarget, findOnPath, NPM_SHIM_ENTRY } };
