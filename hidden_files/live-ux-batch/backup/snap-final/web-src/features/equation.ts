/**
 * Equation model and SVG typesetter (Insert > Symbols > Equation).
 *
 * A small math tree (fraction, superscript, subscript, square root, sum,
 * integral) laid out with deterministic estimated metrics — no DOM or
 * canvas needed, so it is unit-testable and renders identically on the
 * server and client. The dialog inserts the resulting SVG as a
 * picture-like overlay.
 */

export type EqNode =
  | { t: 'text'; text: string }
  | { t: 'frac'; num: EqNode[]; den: EqNode[] }
  | { t: 'sup'; base: EqNode[]; exp: EqNode[] }
  | { t: 'sub'; base: EqNode[]; sub: EqNode[] }
  | { t: 'sqrt'; body: EqNode[] }
  | { t: 'sum'; lower: EqNode[]; upper: EqNode[]; body: EqNode[] }
  | { t: 'int'; lower: EqNode[]; upper: EqNode[]; body: EqNode[] };

export const textNode = (text: string): EqNode => ({ t: 'text', text });
export const fracNode = (num: string, den: string): EqNode => ({ t: 'frac', num: [textNode(num)], den: [textNode(den)] });
export const supNode = (base: string, exp: string): EqNode => ({ t: 'sup', base: [textNode(base)], exp: [textNode(exp)] });
export const subNode = (base: string, sub: string): EqNode => ({ t: 'sub', base: [textNode(base)], sub: [textNode(sub)] });
export const sqrtNode = (body: string): EqNode => ({ t: 'sqrt', body: [textNode(body)] });
export const sumNode = (lower: string, upper: string, body: string): EqNode => ({
  t: 'sum', lower: [textNode(lower)], upper: [textNode(upper)], body: [textNode(body)],
});
export const intNode = (lower: string, upper: string, body: string): EqNode => ({
  t: 'int', lower: [textNode(lower)], upper: [textNode(upper)], body: [textNode(body)],
});

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Placed {
  w: number;
  h: number;
  /** Baseline measured from the top. */
  bl: number;
  svg: string;
}

const FONT = "font-family=\"'Times New Roman', serif\" font-style=\"italic\"";

function measure(text: string, fs: number): number {
  return text.length * fs * 0.55;
}

/** Lay out a horizontal row of nodes on a shared baseline. */
function layoutRow(nodes: EqNode[], fs: number): Placed {
  const parts = nodes.map((n) => layout(n, fs));
  const bl = Math.max(...parts.map((p) => p.bl), fs * 0.8);
  const h = Math.max(...parts.map((p) => bl + (p.h - p.bl)), bl + fs * 0.2);
  const w = parts.reduce((a, p) => a + p.w, 0);
  let x = 0;
  const svg = parts
    .map((p) => {
      const s = `<g transform="translate(${x},${bl - p.bl})">${p.svg}</g>`;
      x += p.w;
      return s;
    })
    .join('');
  return { w, h, bl, svg };
}

function layout(node: EqNode, fs: number): Placed {
  switch (node.t) {
    case 'text': {
      const w = Math.max(measure(node.text, fs), 1);
      const bl = fs * 0.8;
      return {
        w, h: fs, bl,
        svg: `<text x="0" y="${bl.toFixed(1)}" font-size="${fs}" ${FONT}>${escapeXml(node.text)}</text>`,
      };
    }
    case 'frac': {
      const num = layoutRow(node.num, fs * 0.9);
      const den = layoutRow(node.den, fs * 0.9);
      const w = Math.max(num.w, den.w) + 10;
      const gap = 4;
      const numY = 0;
      const lineY = num.h + gap;
      const denY = lineY + gap;
      const h = denY + den.h;
      const svg =
        `<g transform="translate(${(w - num.w) / 2},${numY})">${num.svg}</g>` +
        `<line x1="4" y1="${lineY}" x2="${w - 4}" y2="${lineY}" stroke="black" stroke-width="1"/>` +
        `<g transform="translate(${(w - den.w) / 2},${denY})">${den.svg}</g>`;
      return { w, h, bl: lineY, svg };
    }
    case 'sup':
    case 'sub': {
      const base = layoutRow(node.base, fs);
      const script = layoutRow(node.t === 'sup' ? node.exp : node.sub, fs * 0.68);
      const shift = node.t === 'sup' ? fs * 0.55 : -fs * 0.3;
      const w = base.w + script.w + 1;
      const top = Math.min(0, base.bl - shift - script.bl);
      const h = Math.max(base.h, base.bl - shift - script.bl + script.h) - top;
      const svg =
        `<g transform="translate(0,${-top})">${base.svg}</g>` +
        `<g transform="translate(${base.w + 1},${base.bl - shift - script.bl - top})">${script.svg}</g>`;
      return { w, h, bl: base.bl - top, svg };
    }
    case 'sqrt': {
      const body = layoutRow(node.body, fs);
      const symFs = fs * 1.5;
      const symW = symFs * 0.62;
      const over = 3;
      const w = symW + body.w + 2;
      const h = body.h + over + 2;
      const svg =
        `<text x="0" y="${(over + symFs * 0.85).toFixed(1)}" font-size="${symFs}" ${FONT}>√</text>` +
        `<line x1="${symW - 2}" y1="${over}" x2="${w}" y2="${over}" stroke="black" stroke-width="1"/>` +
        `<g transform="translate(${symW},${over + 1})">${body.svg}</g>`;
      return { w, h, bl: over + 1 + body.bl, svg };
    }
    case 'sum': {
      const symFs = fs * 2.1;
      const symW = symFs * 0.75;
      const lower = layoutRow(node.lower, fs * 0.68);
      const upper = layoutRow(node.upper, fs * 0.68);
      const body = layoutRow(node.body, fs);
      const limW = Math.max(lower.w, upper.w, symW);
      const w = limW + 4 + body.w;
      const h = upper.h + symFs + lower.h + 4;
      const cx = limW / 2;
      const bodyY = (h - body.h) / 2;
      const svg =
        `<g transform="translate(${cx - upper.w / 2},0)">${upper.svg}</g>` +
        `<text x="${cx - symW / 2}" y="${(upper.h + symFs * 0.85).toFixed(1)}" font-size="${symFs}" ${FONT}>∑</text>` +
        `<g transform="translate(${cx - lower.w / 2},${upper.h + symFs + 2})">${lower.svg}</g>` +
        `<g transform="translate(${limW + 4},${bodyY})">${body.svg}</g>`;
      return { w, h, bl: bodyY + body.bl, svg };
    }
    case 'int': {
      const symFs = fs * 2.1;
      const symW = symFs * 0.5;
      const lower = layoutRow(node.lower, fs * 0.68);
      const upper = layoutRow(node.upper, fs * 0.68);
      const body = layoutRow(node.body, fs);
      const w = symW + Math.max(lower.w, upper.w) + 2 + body.w;
      const h = Math.max(symFs, upper.h + symFs * 0.4 + lower.h);
      const svg =
        `<text x="0" y="${(symFs * 0.9).toFixed(1)}" font-size="${symFs}" ${FONT}>∫</text>` +
        `<g transform="translate(${symW},0)">${upper.svg}</g>` +
        `<g transform="translate(${symW},${Math.max(0, h - lower.h)})">${lower.svg}</g>` +
        `<g transform="translate(${symW + Math.max(lower.w, upper.w) + 2},${(h - body.h) / 2})">${body.svg}</g>`;
      return { w, h, bl: (h - body.h) / 2 + body.bl, svg };
    }
  }
}

/**
 * Typeset an equation (list of top-level nodes) to a standalone SVG.
 * Returns the SVG string plus its pixel dimensions for the overlay.
 */
export function equationSvg(nodes: EqNode[], fontSize = 22): { svg: string; width: number; height: number } {
  const placed = layoutRow(nodes.length > 0 ? nodes : [textNode('')], fontSize);
  const width = Math.ceil(placed.w + 8);
  const height = Math.ceil(placed.h + 8);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g transform="translate(4,4)">${placed.svg}</g></svg>`;
  return { svg, width, height };
}

/** Linear text form of an equation (for accessibility / alt text). */
export function equationToText(nodes: EqNode[]): string {
  const one = (ns: EqNode[]): string => ns.map((n) => equationToText([n])).join('');
  return nodes
    .map((n): string => {
      switch (n.t) {
        case 'text': return n.text;
        case 'frac': return `(${one(n.num)})/(${one(n.den)})`;
        case 'sup': return `${one(n.base)}^(${one(n.exp)})`;
        case 'sub': return `${one(n.base)}_(${one(n.sub)})`;
        case 'sqrt': return `√(${one(n.body)})`;
        case 'sum': return `∑_(${one(n.lower)})^(${one(n.upper)}) ${one(n.body)}`;
        case 'int': return `∫_(${one(n.lower)})^(${one(n.upper)}) ${one(n.body)}`;
      }
    })
    .join('');
}
