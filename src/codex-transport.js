'use strict';

const fs = require('fs');
const path = require('path');
const { CODEX_HOME, CATALOG_FILE, PROXY_BASE } = require('./config');

const PROVIDER_ID = 'pet_office_opencodex_http';

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

module.exports = { PROVIDER_ID, usesOpenCodexProxy, httpProviderArgs };
