/**
 * Small XML helpers shared by the native worksheet-feature modules
 * (mergeCellsXml, autoFilterXml, dataValidationXml,
 * conditionalFormattingXml). Same regex/scanner conventions as
 * protectionXml.ts / stylesXml.ts: browser-safe, no DOM, best-effort.
 */

/** Escape element text (`&`, `<`, `>`). */
export function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape an attribute value (text escapes + `"`). */
export function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;');
}

/** Decode XML entities in attribute values / element text. */
export function unescapeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse a tag's attribute text (or a whole tag) into a record. */
export function parseAttrRecord(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out[m[1] as string] = unescapeXmlText(m[2] as string);
  if (Object.keys(out).length === 0 && text.includes("'")) {
    const reSq = /([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;
    while ((m = reSq.exec(text)) !== null) out[m[1] as string] = unescapeXmlText(m[2] as string);
  }
  return out;
}

/** One attribute of a tag string, or null. */
export function attrOf(tag: string, name: string): string | null {
  const v = parseAttrRecord(tag)[name];
  return v === undefined ? null : v;
}

/** OOXML boolean: "1"/"true" (any case), else the default. */
export function boolAttrValue(value: string | null | undefined, dflt: boolean): boolean {
  if (value === null || value === undefined) return dflt;
  const t = value.trim().toLowerCase();
  if (t === '1' || t === 'true') return true;
  if (t === '0' || t === 'false') return false;
  return dflt;
}

/** Numeric attribute, or undefined when absent/unparseable. */
export function numAttrValue(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Split a block's inner XML into its top-level elements named `tag`
 * (quote-aware scanner, like stylesXml.splitElements — a child element
 * ending in `/>` must not truncate its parent).
 */
export function splitTopElements(inner: string, tag: string): string[] {
  const out: string[] = [];
  const open = `<${tag}`;
  let i = 0;
  while (true) {
    const start = inner.indexOf(open, i);
    if (start < 0) break;
    const after = inner[start + open.length] ?? '';
    if (after !== '' && !/[\s/>]/.test(after)) {
      i = start + open.length;
      continue;
    }
    let j = start + open.length;
    let quote: string | null = null;
    let openEnd = -1;
    for (; j < inner.length; j++) {
      const ch = inner[j] as string;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        openEnd = j;
        break;
      }
    }
    if (openEnd < 0) break;
    if (inner[openEnd - 1] === '/') {
      out.push(inner.slice(start, openEnd + 1));
      i = openEnd + 1;
    } else {
      const closeTag = `</${tag}>`;
      const close = inner.indexOf(closeTag, openEnd + 1);
      if (close < 0) break;
      out.push(inner.slice(start, close + closeTag.length));
      i = close + closeTag.length;
    }
  }
  return out;
}

export interface XmlBlock {
  /** Full element text, open tag through close tag (or the self-closed tag). */
  whole: string;
  /** Attribute text of the open tag. */
  attrs: Record<string, string>;
  /** Inner XML ('' for a self-closed element). */
  inner: string;
  /** Span in the source string. */
  start: number;
  end: number;
}

/** All top-level blocks named `tag` in `xml` (document order). */
export function findBlocks(xml: string, tag: string): XmlBlock[] {
  const out: XmlBlock[] = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const start = m.index;
    // Find the end of the open tag (quote-aware).
    let j = start + tag.length + 1;
    let quote: string | null = null;
    let openEnd = -1;
    for (; j < xml.length; j++) {
      const ch = xml[j] as string;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        openEnd = j;
        break;
      }
    }
    if (openEnd < 0) break;
    const openTag = xml.slice(start, openEnd + 1);
    const attrs = parseAttrRecord(openTag);
    if (xml[openEnd - 1] === '/') {
      out.push({ whole: openTag, attrs, inner: '', start, end: openEnd + 1 });
      re.lastIndex = openEnd + 1;
    } else {
      const closeTag = `</${tag}>`;
      const close = xml.indexOf(closeTag, openEnd + 1);
      if (close < 0) break;
      const end = close + closeTag.length;
      out.push({ whole: xml.slice(start, end), attrs, inner: xml.slice(openEnd + 1, close), start, end });
      re.lastIndex = end;
    }
  }
  return out;
}

/** The first block named `tag`, or null. */
export function findBlock(xml: string, tag: string): XmlBlock | null {
  return findBlocks(xml, tag)[0] ?? null;
}

/** Remove every block named `tag` from `xml`. */
export function stripBlocks(xml: string, tag: string): string {
  const blocks = findBlocks(xml, tag);
  if (blocks.length === 0) return xml;
  let out = '';
  let at = 0;
  for (const b of blocks) {
    out += xml.slice(at, b.start);
    at = b.end;
  }
  return out + xml.slice(at);
}

/** Text body of an element string (`<x a="1">body</x>` -> body, decoded). */
export function elementBody(el: string): string {
  const gt = el.indexOf('>');
  if (gt < 0 || el.endsWith('/>')) return '';
  const close = el.lastIndexOf('</');
  if (close < 0) return '';
  return unescapeXmlText(el.slice(gt + 1, close));
}

/**
 * Normalize an A1 range/cell ref for the model: uppercase, `$` removed,
 * whitespace trimmed. (`$a$1:$c$3` -> `A1:C3`.) Excel writes refs in
 * exactly this canonical form; normalizing on parse makes read->write
 * round-trips byte-stable.
 */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/\$/g, '').toUpperCase();
}

/** Normalize a space-separated sqref list (`A1 B2:C3` -> `A1 B2:C3`). */
export function normalizeSqref(sqref: string): string {
  return sqref
    .split(/\s+/)
    .map((p) => normalizeRef(p))
    .filter((p) => p !== '')
    .join(' ');
}
