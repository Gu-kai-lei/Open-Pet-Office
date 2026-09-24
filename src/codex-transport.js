'use strict';

const fs = require('fs');
const path = require('path');
const { CODEX_HOME, CATALOG_FILE, PROXY_BASE } = require('./config');

const PROVIDER_ID = 'pet_office_opencodex_http';
const MANAGED_BEGIN = '# >>> pet-office managed provider: opencodex-http >>>';
const MANAGED_END = '# <<< pet-office managed provider: opencodex-http <<<';

function usesOpenCodexProxy() {
  if (process.env.PET_OFFICE_FORCE_OPENCODEX_HTTP === '1') return true;
  if (process.env.PET_OFFICE_FORCE_OPENCODEX_HTTP === '0') return false;
  try {
    const config = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    if (/^\s*openai_base_url\s*=/m.test(config) && config.includes(PROXY_BASE)) return true;
  } catch {}
  return fs.existsSync(CATALOG_FILE)
    && fs.existsSync(path.join(path.dirname(CODEX_HOME), '.opencodex', 'runtime-port.json'));
}

function httpProviderArgs(enabled = usesOpenCodexProxy()) {
  if (!enabled) return [];
  return [
    // Keep values free of embedded quotes/spaces so cmd.exe passes them to
    // the codex.cmd shim unchanged. Codex treats unparsed TOML as a literal.
    '-c', 'model_provider=' + PROVIDER_ID,
    '-c', 'model_providers.' + PROVIDER_ID + '.name=OpenCodex_HTTP',
    '-c', 'model_providers.' + PROVIDER_ID + '.base_url=' + PROXY_BASE + '/v1',
    '-c', 'model_providers.' + PROVIDER_ID + '.wire_api=responses',
    '-c', 'model_providers.' + PROVIDER_ID + '.requires_openai_auth=true',
    '-c', 'model_providers.' + PROVIDER_ID + '.supports_websockets=false',
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function providerBlockText() {
  return [
    MANAGED_BEGIN,
    '[model_providers.' + PROVIDER_ID + ']',
    'name = "OpenCodex_HTTP"',
    'base_url = "' + PROXY_BASE + '/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    MANAGED_END,
  ].join('\n');
}

// Threads record the provider used to create them. Codex Desktop resolves that
// provider against the user's config.toml when a thread is opened, so an
// override-only provider makes every Pet Office conversation unreadable in the
// desktop app afterwards. Persist a clearly marked, additive definition so
// completed threads stay viewable; the default model_provider is never changed.
function mergeProviderBlock(text) {
  const block = providerBlockText();
  const managed = new RegExp(escapeRegExp(MANAGED_BEGIN) + '[\\s\\S]*?' + escapeRegExp(MANAGED_END) + '\\r?\\n?');
  if (managed.test(text)) {
    const updated = text.replace(managed, block + '\n');
    return { text: updated, changed: updated !== text, blocked: false };
  }
  if (new RegExp('^\\s*\\[model_providers\\.' + escapeRegExp(PROVIDER_ID) + '\\]', 'm').test(text)) {
    return { text, changed: false, blocked: true };
  }
  const prefix = text ? (text.endsWith('\n') ? text + '\n' : text + '\n\n') : '';
  return { text: prefix + block + '\n', changed: true, blocked: false };
}

function ensureUserProviderConfig(enabled = usesOpenCodexProxy()) {
  if (!enabled) return { ok: true, changed: false, reason: 'disabled' };
  const file = path.join(CODEX_HOME, 'config.toml');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const merged = mergeProviderBlock(text);
  if (!merged.changed) return { ok: true, changed: false, reason: merged.blocked ? 'unmanaged' : 'current' };
  fs.writeFileSync(file, merged.text, 'utf8');
  return { ok: true, changed: true };
}

module.exports = { PROVIDER_ID, usesOpenCodexProxy, httpProviderArgs, ensureUserProviderConfig, mergeProviderBlock };
