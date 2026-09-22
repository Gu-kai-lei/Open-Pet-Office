'use strict';

// 拖拽文件收件箱：把用户拖入的文件复制到项目工作区的 inbox/ 目录，
// 这样主管、工作者和任何接入的模型都能直接按路径读取。
const fs = require('fs');
const path = require('path');
const { workspacePath } = require('./path-safety');

const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

const KIND_RULES = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|ico|heic)$/i, '图片'],
  [/\.(mp4|mov|avi|mkv|webm|m4v)$/i, '视频'],
  [/\.(mp3|wav|m4a|flac|ogg|aac)$/i, '音频'],
  [/\.pdf$/i, 'PDF'],
  [/\.(docx?|odt|rtf)$/i, '文档'],
  [/\.(xlsx?|csv|ods)$/i, '表格'],
  [/\.(pptx?|odp)$/i, '演示'],
  [/\.(txt|md|markdown|log)$/i, '文本'],
  [/\.(json|ya?ml|toml|ini|xml|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|ps1|bat|cmd|sql)$/i, '代码'],
  [/\.(zip|7z|rar|tar|gz|bz2|xz)$/i, '压缩包'],
];

function fileKind(name) {
  const value = String(name || '');
  for (const [pattern, label] of KIND_RULES) if (pattern.test(value)) return label;
  return '文件';
}

function safeFileName(name) {
  const base = path.basename(String(name || 'file'));
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  const limited = cleaned.length > 80 ? cleaned.slice(-80) : cleaned;
  return limited || 'file';
}

function candidateTarget(dir, name, index) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, name.length - extension.length) : name;
  return path.join(dir, index ? stem + '-' + index + extension : name);
}

function copyUnique(source, projectPath, name) {
  for (let index = 0; index <= 9999; index++) {
    const target = workspacePath(projectPath, path.join('inbox', path.basename(candidateTarget('', name, index))));
    try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); return target; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名附件过多，请重命名后重试');
}

async function copyUniqueAsync(source, projectPath, name) {
  for (let index = 0; index <= 9999; index++) {
    const target = workspacePath(projectPath, path.join('inbox', path.basename(candidateTarget('', name, index))));
    try { await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL); return target; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  throw new Error('同名附件过多，请重命名后重试');
}

function ingestFiles({ paths, projectPath, maxFiles = MAX_FILES, maxBytes = MAX_FILE_BYTES } = {}) {
  const result = { ok: false, files: [], skipped: [], error: null };
  if (!projectPath) {
    result.error = '缺少项目工作区。';
    return result;
  }
  const list = (Array.isArray(paths) ? paths : []).filter(value => typeof value === 'string' && value.trim());
  if (!list.length) {
    result.error = '没有收到文件。';
    return result;
  }
  try {
    fs.mkdirSync(workspacePath(projectPath, 'inbox'), { recursive: true });
  } catch (error) {
    result.error = '无法创建工作区收件箱：' + error.message;
    return result;
  }
  for (const source of list) {
    if (result.files.length >= maxFiles) {
      result.skipped.push({ path: source, reason: '一次最多接收 ' + maxFiles + ' 个文件' });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      result.skipped.push({ path: source, reason: '文件不存在' });
      continue;
    }
    if (!stat.isFile()) {
      result.skipped.push({ path: source, reason: '不是文件' });
      continue;
    }
    if (stat.size > maxBytes) {
      result.skipped.push({ path: source, reason: '超过 ' + Math.round(maxBytes / 1048576) + 'MB' });
      continue;
    }
    let target;
    try {
      target = copyUnique(source, projectPath, safeFileName(source));
    } catch (error) {
      result.skipped.push({ path: source, reason: '复制失败：' + error.message });
      continue;
    }
    result.files.push({
      name: path.basename(target),
      path: target,
      relPath: path.relative(projectPath, target).split(path.sep).join('/'),
      size: stat.size,
      kind: fileKind(target),
    });
  }
  result.ok = result.files.length > 0;
  if (!result.ok && !result.error) {
    result.error = result.skipped.length ? '文件无法接收：' + result.skipped[0].reason : '没有收到文件。';
  }
  return result;
}

async function ingestFilesAsync({ paths, projectPath, maxFiles = MAX_FILES, maxBytes = MAX_FILE_BYTES, onProgress } = {}) {
  const result = { ok: false, files: [], skipped: [], error: null };
  if (!projectPath) {
    result.error = '缺少项目工作区。';
    return result;
  }
  const list = (Array.isArray(paths) ? paths : []).filter(value => typeof value === 'string' && value.trim());
  if (!list.length) {
    result.error = '没有收到文件。';
    return result;
  }
  try {
    await fs.promises.mkdir(workspacePath(projectPath, 'inbox'), { recursive: true });
  } catch (error) {
    result.error = '无法创建工作区收件箱：' + error.message;
    return result;
  }
  for (let index = 0; index < list.length; index += 1) {
    const source = list[index];
    if (result.files.length >= maxFiles) {
      result.skipped.push({ path: source, reason: '一次最多接收 ' + maxFiles + ' 个文件' });
      continue;
    }
    let stat;
    try {
      stat = await fs.promises.stat(source);
    } catch {
      result.skipped.push({ path: source, reason: '文件不存在' });
      continue;
    }
    if (!stat.isFile()) {
      result.skipped.push({ path: source, reason: '不是文件' });
      continue;
    }
    if (stat.size > maxBytes) {
      result.skipped.push({ path: source, reason: '超过 ' + Math.round(maxBytes / 1048576) + 'MB' });
      continue;
    }
    let target;
    try {
      if (onProgress) onProgress({ phase: 'copying', index, total: list.length, name: path.basename(source), size: stat.size });
      target = await copyUniqueAsync(source, projectPath, safeFileName(source));
    } catch (error) {
      result.skipped.push({ path: source, reason: '复制失败：' + error.message });
      continue;
    }
    result.files.push({
      name: path.basename(target),
      path: target,
      relPath: path.relative(projectPath, target).split(path.sep).join('/'),
      size: stat.size,
      kind: fileKind(target),
    });
    if (onProgress) onProgress({ phase: 'copied', index: index + 1, total: list.length, name: path.basename(target), size: stat.size });
  }
  result.ok = result.files.length > 0;
  if (!result.ok && !result.error) {
    result.error = result.skipped.length ? '文件无法接收：' + result.skipped[0].reason : '没有收到文件。';
  }
  return result;
}

module.exports = { ingestFiles, ingestFilesAsync, fileKind, safeFileName, MAX_FILES, MAX_FILE_BYTES };
