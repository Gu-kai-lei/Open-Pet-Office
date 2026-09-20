'use strict';

const { inferCapabilities } = require('./model-capabilities');

function taskNeeds(taskText) {
  const text = String(taskText || '').toLowerCase();
  return {
    code: /代码|编程|开发|实现|修复|调试|测试|build|code|debug|implement|refactor|api|前端|后端/.test(text),
    vision: /图片|图像|视觉|截图|海报|设计|视频|image|vision|screenshot|ui|界面/.test(text),
    longContext: /长文|论文|报告|ppt|文档|全项目|仓库|调研|总结|research|document|slides|repository/.test(text),
    verify: /核验|审查|复核|检查|测试|review|verify|audit|test/.test(text),
    speed: /快速|尽快|马上|fast|quick/.test(text),
    cost: /省钱|低成本|便宜|cost|cheap/.test(text),
  };
}

function scoreWorker(worker, model, needs) {
  const capabilities = (model && model.capabilities) || inferCapabilities(model || { slug: worker.model || '' });
  let score = 1;
  const reasons = [];
  if (needs.code && capabilities.code) { score += 5; reasons.push('代码'); }
  if (needs.vision && capabilities.vision) { score += 5; reasons.push('视觉'); }
  if (needs.longContext && capabilities.longContext) { score += 4; reasons.push('长上下文'); }
  if (needs.speed && capabilities.speed === 'fast') { score += 3; reasons.push('速度'); }
  if (needs.cost && ['free', 'low'].includes(capabilities.cost)) { score += 2; reasons.push('成本'); }
  if (!worker.model) { score += .25; reasons.push('Codex 默认'); }
  return { worker, capabilities, score, reasons };
}

function recommendAgents({ taskText, workers = [], models = [], max = 3 } = {}) {
  const needs = taskNeeds(taskText);
  const modelMap = new Map(models.map(model => [model.slug, model]));
  const ranked = workers.map(worker => scoreWorker(worker, modelMap.get(worker.model) || null, needs))
    .sort((a, b) => b.score - a.score || String(a.worker.id).localeCompare(String(b.worker.id)));
  const complex = Object.values(needs).filter(Boolean).length >= 2 || String(taskText || '').length >= 80;
  const desired = Math.min(Math.max(complex || needs.verify ? 2 : 1, 1), Math.max(1, Math.min(max, ranked.length)));
  const selected = ranked.slice(0, desired).map((entry, index) => ({
    petId: entry.worker.id,
    model: entry.worker.model || null,
    score: entry.score,
    reason: entry.reasons.length ? entry.reasons.join('、') + '能力匹配' : (index === 0 ? '综合能力最合适' : '用于交叉核验'),
    capabilities: entry.capabilities,
  }));
  return { needs, selected, considered: ranked.length };
}

module.exports = { taskNeeds, recommendAgents };
