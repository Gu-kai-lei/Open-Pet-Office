'use strict';
const fs = require('fs');
const { CATALOG_FILE, log } = require('./config');
const { inferCapabilities } = require('./model-capabilities');

let cache = { at: 0, models: [] };

function providerOf(slug) {
  return slug && slug.includes('/') ? slug.split('/')[0] : 'openai';
}

function loadModels(force = false) {
  const now = Date.now();
  if (!force && cache.models.length && now - cache.at < 30000) return cache.models;
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    const models = (raw.models || [])
      .filter(m => m && m.slug)
      .map(m => ({
        slug: m.slug,
        name: m.display_name || m.slug,
        provider: m.provider || m.provider_id || providerOf(m.slug),
        capabilities: inferCapabilities(m),
      }));
    if (models.length) cache = { at: now, models };
  } catch (e) {
    log('catalog read failed: ' + e.message);
  }
  return cache.models;
}

module.exports = { loadModels, providerOf };
