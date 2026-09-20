'use strict';

function bool(...values) {
  return values.some(value => value === true || value === 'true');
}

function number(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function textList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'object') return Object.keys(value).filter(key => value[key]);
  return [String(value)];
}

function inferCapabilities(model = {}) {
  const slug = String(model.slug || model.id || '').toLowerCase();
  const name = String(model.display_name || model.name || slug).toLowerCase();
  const provider = String(model.provider || model.provider_id || '').toLowerCase();
  const haystack = [slug, name, provider].join(' ');
  const modalities = [
    ...textList(model.input_modalities),
    ...textList(model.modalities),
    ...textList(model.capabilities && model.capabilities.input),
  ].map(value => value.toLowerCase());
  const contextWindow = number(model.context_window, model.contextWindow, model.max_context_tokens, model.max_input_tokens);
  const rawPrice = model.pricing || model.price || {};
  const inputPrice = number(rawPrice.input, rawPrice.prompt, model.input_price, model.prompt_price);
  const outputPrice = number(rawPrice.output, rawPrice.completion, model.output_price, model.completion_price);

  const code = bool(model.supports_code, model.capabilities && model.capabilities.code)
    || /codex|coder|coding|code[-_ ]|devstral|codestral|qwen.*coder|glm/.test(haystack);
  const vision = bool(model.supports_vision, model.vision, model.capabilities && model.capabilities.vision)
    || modalities.some(value => /image|vision/.test(value))
    || /vision|\bvl\b|multimodal|omni/.test(haystack);
  const longContext = bool(model.long_context, model.capabilities && model.capabilities.longContext)
    || (contextWindow != null && contextWindow >= 128000)
    || /long[-_ ]?context|1m|million/.test(haystack);

  let speed = 'balanced';
  if (/flash|mini|nano|lite|turbo|fast|haiku/.test(haystack)) speed = 'fast';
  else if (/reasoner|reasoning|pro|max|ultra|opus/.test(haystack)) speed = 'deliberate';

  let cost = 'medium';
  if (/local|ollama|free/.test(haystack)) cost = 'free';
  else if (inputPrice != null || outputPrice != null) {
    const price = Math.max(inputPrice || 0, outputPrice || 0);
    cost = price <= 1 ? 'low' : (price >= 10 ? 'high' : 'medium');
  } else if (/flash|mini|nano|lite|cheap/.test(haystack)) cost = 'low';
  else if (/pro|max|ultra|opus/.test(haystack)) cost = 'high';

  return { code, vision, longContext, speed, cost, contextWindow };
}

module.exports = { inferCapabilities };
