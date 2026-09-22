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

module.exports = { workspacePath };
