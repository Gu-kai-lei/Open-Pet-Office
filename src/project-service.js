'use strict';

const fs = require('fs');
const path = require('path');
const { workspacePath } = require('./path-safety');

function hydrateProject(project = {}) {
  const now = Date.now();
  return {
    ...project,
    archived: !!project.archived,
    threadIds: Array.isArray(project.threadIds) ? project.threadIds.filter(Boolean).slice(-50) : [],
    createdAt: Number(project.createdAt) || now,
    updatedAt: Number(project.updatedAt) || Number(project.createdAt) || now,
  };
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function clearProjectInbox(projectPath) {
  const projectRoot = path.resolve(projectPath);
  const inboxPath = workspacePath(projectRoot, 'inbox');
  if (!isPathInside(projectRoot, inboxPath) || path.basename(inboxPath).toLowerCase() !== 'inbox') throw new Error('附件目录校验失败');
  if (!fs.existsSync(inboxPath)) return { count: 0, bytes: 0, inboxPath };
  const entries = fs.readdirSync(inboxPath, { withFileTypes: true });
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    const target = workspacePath(projectRoot, path.join('inbox', entry.name));
    if (!isPathInside(inboxPath, target)) throw new Error('附件路径越界');
    try {
      const stat = fs.lstatSync(target);
      bytes += stat.isFile() ? stat.size : 0;
      fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
      count++;
    } catch (error) {
      throw new Error('无法清理附件 ' + entry.name + '：' + error.message);
    }
  }
  return { count, bytes, inboxPath };
}

module.exports = { hydrateProject, isPathInside, clearProjectInbox };
