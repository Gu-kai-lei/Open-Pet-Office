'use strict';

const SENSITIVE_QUERY = /^(access[_-]?token|token|signature|authorization|auth|api[_-]?key|secret|password)$/i;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cleanTitle(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 120);
}

function safeHttpUrl(value) {
  const raw = decodeEntities(String(value || '').trim().replace(/^<|>$/g, ''));
  if (!raw || /[\u0000-\u001f]/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) if (SENSITIVE_QUERY.test(key)) parsed.searchParams.set(key, '[已隐藏]');
    return parsed.toString();
  } catch { return null; }
}

function htmlLinks(html) {
  const source = String(html || '');
  const links = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(source)) && links.length < 20) links.push({ url: match[1] || match[2] || match[3], title: cleanTitle(match[4]) });
  return links;
}

function normalizeDroppedLinks({ uriList = '', plain = '', html = '' } = {}) {
  const candidates = htmlLinks(html);
  for (const line of String(uriList || '').split(/\r?\n/)) if (line.trim() && !line.trim().startsWith('#')) candidates.push({ url: line.trim(), title: '' });
  for (const token of String(plain || '').split(/\s+/)) if (/^https?:\/\//i.test(token)) candidates.push({ url: token, title: '' });
  const seen = new Set();
  const output = [];
  for (const candidate of candidates) {
    const url = safeHttpUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const parsed = new URL(url);
    const fallback = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname).replace(/[-_]+/g, ' ');
    output.push({ type: 'link', url, name: candidate.title || fallback || parsed.hostname, domain: parsed.hostname, kind: '链接', size: 0 });
    if (output.length >= 20) break;
  }
  return output;
}

module.exports = { normalizeDroppedLinks, safeHttpUrl, cleanTitle };
