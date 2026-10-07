// Small shared helpers: output caps with an explicit truncation marker, and a tiny tolerant XML reader.

/** Cap a list; returns { items, more } where more is the number of dropped entries. */
export function capList(items, max) {
  return items.length > max ? { items: items.slice(0, max), more: items.length - max } : { items, more: 0 };
}

/** Cap text at maxChars on a line boundary and append "(truncated N more chars)". */
export function capText(text, maxChars = 12000) {
  if (text.length <= maxChars) return text;
  let cut = text.lastIndexOf('\n', maxChars);
  if (cut < maxChars * 0.6) cut = maxChars;
  return `${text.slice(0, cut)}\n(truncated ${text.length - cut} more chars)`;
}

export const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
export function decodeXml(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENT[m]);
}

/** Parse attributes out of a tag's attribute string. */
export function parseAttrs(str = '') {
  const out = {};
  for (const m of str.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXml(m[2] ?? m[3]);
  return out;
}

/** Find all <tag ...>...</tag> or <tag .../> elements. Returns [{attrs, body}]. Not nested-aware for the same tag name. */
export function elements(xml, tag) {
  const re = new RegExp(`<${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'g');
  const out = [];
  for (const m of xml.matchAll(re)) out.push({ attrs: parseAttrs(m[1]), body: m[3] ?? '' });
  return out;
}
