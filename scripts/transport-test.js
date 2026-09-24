'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_ID, httpProviderArgs } = require('../src/codex-transport');

assert.deepEqual(httpProviderArgs(false), []);
const args = httpProviderArgs(true);
assert(args.includes('model_provider=' + PROVIDER_ID));
assert(args.includes('model_providers.' + PROVIDER_ID + '.base_url=http://127.0.0.1:10100/v1'));
assert(args.includes('model_providers.' + PROVIDER_ID + '.wire_api=responses'));
assert(args.includes('model_providers.' + PROVIDER_ID + '.requires_openai_auth=true'));
assert(args.includes('model_providers.' + PROVIDER_ID + '.supports_websockets=false'));

for (const file of ['src/appserver.js', 'src/planner.js', 'src/dispatcher.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert(source.includes('httpProviderArgs'), file + ' must select the OpenCodex-compatible HTTP provider');
}

console.log('transport: OpenCodex HTTP provider disables unsupported Responses WebSocket mode');
