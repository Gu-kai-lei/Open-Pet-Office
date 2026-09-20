'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inferCapabilities } = require('../src/model-capabilities');
const { recommendAgents } = require('../src/recommender');
const { hydrateProject, isPathInside, clearProjectInbox } = require('../src/project-service');

function testCapabilities() {
  const coder = inferCapabilities({ slug: 'deepseek/deepseek-coder-flash', context_window: 131072 });
  assert.equal(coder.code, true);
  assert.equal(coder.longContext, true);
  assert.equal(coder.speed, 'fast');
  assert.equal(coder.cost, 'low');
  const vision = inferCapabilities({ slug: 'qwen-vl', input_modalities: ['text', 'image'] });
  assert.equal(vision.vision, true);
}

function testRecommendation() {
  const workers = [
    { id: 'w1', model: 'fast-code' },
    { id: 'w2', model: 'vision-pro' },
    { id: 'w3', model: 'plain' },
  ];
  const models = [
    { slug: 'fast-code', capabilities: { code: true, vision: false, longContext: false, speed: 'fast', cost: 'low' } },
    { slug: 'vision-pro', capabilities: { code: false, vision: true, longContext: true, speed: 'deliberate', cost: 'high' } },
    { slug: 'plain', capabilities: { code: false, vision: false, longContext: false, speed: 'balanced', cost: 'medium' } },
  ];
  const result = recommendAgents({ taskText: '请快速实现代码并核验测试', workers, models, max: 3 });
  assert.equal(result.selected[0].petId, 'w1');
  assert.equal(result.selected.length, 2);
  assert.match(result.selected[0].reason, /代码|速度/);
}

function testProjects() {
  const hydrated = hydrateProject({ id: 'p1', name: 'Demo', path: 'C:/demo' });
  assert.equal(hydrated.archived, false);
  assert.deepEqual(hydrated.threadIds, []);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-office-v012-'));
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(path.join(inbox, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(inbox, 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(inbox, 'nested', 'b.txt'), 'beta');
  fs.writeFileSync(path.join(root, 'source.txt'), 'must stay');
  assert.equal(isPathInside(root, inbox), true);
  assert.equal(isPathInside(inbox, root), false);
  const result = clearProjectInbox(root);
  assert.equal(result.count, 2);
  assert.equal(fs.readdirSync(inbox).length, 0);
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'must stay');
  fs.rmSync(root, { recursive: true, force: true });
}

testCapabilities();
testRecommendation();
testProjects();
console.log('v0.12 project, capability and recommendation tests passed');
