'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ingestFiles, ingestFilesAsync, fileKind, safeFileName } = require('../src/inbox');

(async () => {

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-inbox-'));
const project = path.join(root, 'project');
fs.mkdirSync(project, { recursive: true });

const source = path.join(root, 'source');
fs.mkdirSync(source, { recursive: true });
const report = path.join(source, '季度报告.pdf');
const photo = path.join(source, 'photo.PNG');
const script = path.join(source, 'app.js');
const folder = path.join(source, 'folder');
fs.writeFileSync(report, 'pdf-bytes', 'utf8');
fs.writeFileSync(photo, 'png-bytes', 'utf8');
fs.writeFileSync(script, 'console.log(1)', 'utf8');
fs.mkdirSync(folder, { recursive: true });

assert.equal(fileKind('a.PNG'), '图片');
assert.equal(fileKind('a.pdf'), 'PDF');
assert.equal(fileKind('a.zip'), '压缩包');
assert.equal(fileKind('noext'), '文件');
assert.equal(safeFileName('..\\bad:name?.txt'), 'bad-name-.txt');

const first = ingestFiles({ paths: [report, photo, script], projectPath: project });
assert.equal(first.ok, true);
assert.equal(first.files.length, 3);
assert.deepEqual(first.files.map(file => file.kind), ['PDF', '图片', '代码']);
assert.equal(first.files[0].relPath, 'inbox/季度报告.pdf');
assert.ok(first.files[0].relPath.includes('/'), '相对路径统一使用正斜杠');
assert.ok(fs.existsSync(path.join(project, 'inbox', '季度报告.pdf')));
assert.ok(fs.existsSync(photo), '源文件保持不动');

const second = ingestFiles({ paths: [report], projectPath: project });
assert.equal(second.files[0].name, '季度报告-1.pdf', '重名文件自动加序号');

const mixed = ingestFiles({ paths: [folder, path.join(source, 'missing.txt'), report], projectPath: project });
assert.equal(mixed.ok, true);
assert.equal(mixed.files.length, 1);
assert.equal(mixed.skipped.length, 2);
assert.match(mixed.skipped[0].reason, /不是文件/);

const limited = ingestFiles({ paths: [report, photo], projectPath: project, maxFiles: 1 });
assert.equal(limited.files.length, 1);
assert.equal(limited.skipped.length, 1);
assert.match(limited.skipped[0].reason, /最多/);

const oversized = ingestFiles({ paths: [report], projectPath: project, maxBytes: 2 });
assert.equal(oversized.ok, false);
assert.match(oversized.error, /超过/);

assert.equal(ingestFiles({ paths: [], projectPath: project }).ok, false);
assert.equal(ingestFiles({ paths: [report] }).ok, false);

const progress = [];
const asyncResult = await ingestFilesAsync({
  paths: [photo, script],
  projectPath: project,
  onProgress: event => progress.push(event),
});
assert.equal(asyncResult.ok, true);
assert.equal(asyncResult.files.length, 2);
assert.equal(progress.filter(event => event.phase === 'copied').length, 2);

fs.rmSync(root, { recursive: true, force: true });
console.log('inbox: copy, rename, filtering, limits and kinds OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
