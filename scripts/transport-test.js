'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER_ID, httpProviderArgs, mergeProviderBlock } = require('../src/codex-transport');

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

const mergedEmpty = mergeProviderBlock('');
assert(mergedEmpty.changed && mergedEmpty.text.includes('[model_providers.' + PROVIDER_ID + ']'));
const mergedTwice = mergeProviderBlock(mergedEmpty.text);
assert(!mergedTwice.changed && mergedTwice.text === mergedEmpty.text, 'provider block must be idempotent');
const staleBlock = mergedEmpty.text.replace('supports_websockets = false', 'supports_websockets = true');
const mergedStale = mergeProviderBlock(staleBlock);
assert(mergedStale.changed && mergedStale.text.includes('supports_websockets = false'), 'managed block must self-heal');
const manual = '[model_providers.' + PROVIDER_ID + ']\nname = "manual"\n';
const mergedManual = mergeProviderBlock(manual);
assert(!mergedManual.changed && mergedManual.blocked, 'unmanaged provider table must not be duplicated');
const crlf = mergeProviderBlock('model = "gpt-5.6"\r\n');
assert(crlf.changed && crlf.text.startsWith('model = "gpt-5.6"\r\n'), 'CRLF config must keep its line endings');

console.log('transport: OpenCodex HTTP provider disables unsupported Responses WebSocket mode');
