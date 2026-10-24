'use strict';

const fs = require('fs');
const path = require('path');

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

// Check every existing path component. A lexical prefix alone allows junctions
// (including a dangling junction) to escape the user's selected workspace.
function workspacePath(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (!inside(resolvedRoot, target)) throw new Error('路径超出项目工作区');
  const realRoot = fs.realpathSync(resolvedRoot);
  let current = resolvedRoot;
  for (const part of path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('为保护项目文件，不能操作链接或 junction 目录：' + part);
    if (!inside(realRoot, fs.realpathSync(current))) throw new Error('真实路径超出项目工作区');
  }
  return target;
}

// shell.openPath launches executables, so the renderer may only open existing
// folders or documents inside roots that the main process already trusts.
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.msi', '.msp', '.scr', '.hta', '.cpl', '.lnk', '.url', '.reg', '.jar', '.pif', '.appref-ms',
]);

function openablePath(candidate, roots) {
  if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) return null;
  let real;
  try { real = fs.realpathSync(path.resolve(candidate)); } catch { return null; }
  const allowed = (roots || []).filter(Boolean).some(root => {
    try {
      const realRoot = fs.realpathSync(path.resolve(root));
      return real === realRoot || inside(realRoot, real);
    } catch { return false; }
  });
  if (!allowed) return null;
  const stat = fs.statSync(real);
  if (stat.isFile() && EXECUTABLE_EXTENSIONS.has(path.extname(real).toLowerCase())) return null;
  return stat.isFile() || stat.isDirectory() ? real : null;
}

module.exports = { workspacePath, openablePath, EXECUTABLE_EXTENSIONS };
