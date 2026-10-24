'use strict';

// Helpers shared by every Mission coordinator (local and Ruflo) so that memory
// namespaces and redaction never depend on which engine created a Mission.
const crypto = require('crypto');

function redact(value) {
  return String(value == null ? '' : value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(api[_ -]?key|token|password|secret)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]');
}

function projectNamespace(projectId) {
  const stable = crypto.createHash('sha256').update(String(projectId || '')).digest('hex').slice(0, 20);
  return 'pet-office-project-' + stable;
}

function sanitizeMemory(value) {
  const walk = (input, key = '') => {
    if (typeof input === 'string') {
      let text = redact(input)
        .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+\\/gi, '[PRIVATE_PATH]\\')
        .replace(/\b[A-Za-z]:\\[^\r\n,;]+/g, '[ABSOLUTE_PATH]');
      if (/attachment|附件/i.test(key)) text = '[附件内容不写入记忆]';
      return text.slice(0, 6000);
    }
    if (Array.isArray(input)) return input.slice(0, 50).map(item => walk(item, key));
    if (input && typeof input === 'object') {
      const output = {};
      for (const [childKey, child] of Object.entries(input)) {
        if (/^(api.?key|token|password|secret|authorization|rawAttachment|conversation)$/i.test(childKey)) continue;
        output[childKey] = walk(child, childKey);
      }
      return output;
    }
    return input;
  };
  return walk(value);
}

module.exports = { redact, projectNamespace, sanitizeMemory };
