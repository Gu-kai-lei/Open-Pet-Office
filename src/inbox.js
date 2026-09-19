'use strict';

// 拖拽文件收件箱：把用户拖入的文件复制到项目工作区的 inbox/ 目录，
// 这样主管、工作者和任何接入的模型都能直接按路径读取。
const fs = require('fs');
const path = require('path');

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

function uniqueTarget(dir, name) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, name.length - extension.length) : name;
  let target = path.join(dir, name);
  let index = 1;
  while (fs.existsSync(target) && index <= 999) {
    target = path.join(dir, stem + '-' + index + extension);
    index += 1;
  }
  return target;
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
  const inbox = path.join(projectPath, 'inbox');
  try {
    fs.mkdirSync(inbox, { recursive: true });
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
    const target = uniqueTarget(inbox, safeFileName(source));
    try {
      fs.copyFileSync(source, target);
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

module.exports = { ingestFiles, fileKind, safeFileName, MAX_FILES, MAX_FILE_BYTES };
