/**
 * Header/footer model with Excel field-code expansion (Page Setup >
 * Header/Footer).
 *
 * Excel codes: &P page number, &N total pages, &D date, &T time, &F file
 * name, &A sheet name, && literal ampersand. Formatting codes (&"font",
 * &NN point size, &B/&I/&U/&S/&X/&Y toggles) are stripped by the plain
 * expander — they affect rendering, not text. Unknown codes are left
 * verbatim so round-trips never lose data.
 *
 * SERVICE-LAYER, pure and headless: operates on plain strings, no DOM.
 * The web header/footer editor (HeaderFooterDialog) and the print preview
 * are clients of this module.
 */

export const HEADER_FOOTER_VERSION = 1 as const;

export interface HFSection {
  left: string;
  center: string;
  right: string;
}

export interface HeaderFooterSettings {
  version: typeof HEADER_FOOTER_VERSION;
  header: HFSection;
  footer: HFSection;
  /** Different odd/even headers/footers (Excel "Different Odd & Even Pages"). */
  differentOddEven: boolean;
  evenHeader?: HFSection;
  evenFooter?: HFSection;
  /** Different first-page header/footer. */
  differentFirst: boolean;
  firstHeader?: HFSection;
  firstFooter?: HFSection;
}

export function emptyHFSection(): HFSection {
  return { left: '', center: '', right: '' };
}

export function defaultHeaderFooter(): HeaderFooterSettings {
  return {
    version: HEADER_FOOTER_VERSION,
    header: emptyHFSection(),
    footer: emptyHFSection(),
    differentOddEven: false,
    differentFirst: false,
  };
}

export function isHFSectionEmpty(s: HFSection | undefined): boolean {
  return !s || (s.left === '' && s.center === '' && s.right === '');
}

export function isHFEmpty(settings: HeaderFooterSettings): boolean {
  return (
    isHFSectionEmpty(settings.header) &&
    isHFSectionEmpty(settings.footer) &&
    isHFSectionEmpty(settings.evenHeader) &&
    isHFSectionEmpty(settings.evenFooter) &&
    isHFSectionEmpty(settings.firstHeader) &&
    isHFSectionEmpty(settings.firstFooter)
  );
}

/** Structural validation; returns human-readable errors (empty = valid). */
export function validateHeaderFooter(settings: HeaderFooterSettings): string[] {
  const errs: string[] = [];
  if (settings.version !== HEADER_FOOTER_VERSION) {
    errs.push(`Unsupported header/footer version: ${String(settings.version)}.`);
  }
  const check = (name: string, s: HFSection | undefined) => {
    if (s === undefined) return;
    for (const pos of ['left', 'center', 'right'] as const) {
      if (typeof s[pos] !== 'string') errs.push(`${name}.${pos} must be a string.`);
    }
  };
  check('header', settings.header);
  check('footer', settings.footer);
  check('evenHeader', settings.evenHeader);
  check('evenFooter', settings.evenFooter);
  check('firstHeader', settings.firstHeader);
  check('firstFooter', settings.firstFooter);
  return errs;
}

export interface HFRenderContext {
  page: number;
  pages: number;
  date: Date;
  fileName: string;
  sheetName: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Expand Excel field codes in a header/footer string to plain text.
 * Formatting codes (&"Font", &NN size, &B &I &U &S &X &Y) are stripped;
 * unknown codes pass through unchanged; "&&" is a literal "&".
 */
export function expandHFCodes(text: string, ctx: HFRenderContext): string {
  const dateStr = `${ctx.date.getFullYear()}-${pad2(ctx.date.getMonth() + 1)}-${pad2(ctx.date.getDate())}`;
  const timeStr = `${pad2(ctx.date.getHours())}:${pad2(ctx.date.getMinutes())}`;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '&') {
      out += ch;
      i += 1;
      continue;
    }
    const code = text[i + 1];
    if (code === undefined) {
      out += '&';
      i += 1;
      continue;
    }
    // Font name: &"Font Name" or &"Font Name,Bold Italic"
    if (code === '"') {
      const end = text.indexOf('"', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    // Point size: &NN
    if (code >= '0' && code <= '9') {
      let j = i + 1;
      while (j < text.length && text[j] >= '0' && text[j] <= '9') j += 1;
      i = j;
      continue;
    }
    switch (code) {
      case '&': out += '&'; break;
      case 'P': out += String(ctx.page); break;
      case 'N': out += String(ctx.pages); break;
      case 'D': out += dateStr; break;
      case 'T': out += timeStr; break;
      case 'F': out += ctx.fileName; break;
      case 'A': out += ctx.sheetName; break;
      // Formatting toggles: no plain-text representation.
      case 'B': case 'I': case 'U': case 'S': case 'X': case 'Y': case 'E': break;
      default: out += '&' + code; break;
    }
    i += 2;
  }
  return out;
}

/** Expand one section's left/center/right strings. */
export function expandHFSection(
  section: HFSection,
  ctx: HFRenderContext,
): { left: string; center: string; right: string } {
  return {
    left: expandHFCodes(section.left, ctx),
    center: expandHFCodes(section.center, ctx),
    right: expandHFCodes(section.right, ctx),
  };
}

/** Join a section's expanded parts for single-line preview. */
export function renderHFSectionPreview(section: HFSection, ctx: HFRenderContext): string {
  const e = expandHFSection(section, ctx);
  return [e.left, e.center, e.right].filter((t) => t !== '').join(' | ');
}

/**
 * Pick the effective header/footer section for a page, honoring
 * different-first and different-odd-even (Excel § page-setup semantics).
 */
export function sectionForPage(
  settings: HeaderFooterSettings,
  kind: 'header' | 'footer',
  page: number,
): HFSection {
  if (page === 1 && settings.differentFirst) {
    const s = kind === 'header' ? settings.firstHeader : settings.firstFooter;
    if (s) return s;
  }
  if (settings.differentOddEven && page % 2 === 0) {
    const s = kind === 'header' ? settings.evenHeader : settings.evenFooter;
    if (s) return s;
  }
  return kind === 'header' ? settings.header : settings.footer;
}
