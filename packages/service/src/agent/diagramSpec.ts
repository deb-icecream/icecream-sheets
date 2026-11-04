/**
 * Deterministic derivation of an in-sheet diagram spec from a chat prompt.
 *
 * No LLM is involved: the layout comes from layout keywords in the prompt
 * and the node labels come from an explicit step list the user stated
 * (arrow chain, "from X to Y", or a colon list). Anything else falls back
 * to the SmartArt dialog's own defaults (Process, Step 1–4), so a chat
 * diagram is never worse than what the dialog inserts with no edits.
 *
 * The web shell renders the spec with SmartShapes.smartArtSvg and inserts
 * it through the same addPicture path the Insert > SmartArt dialog uses —
 * so a chat diagram is a picture in the sheet, movable, and saved with
 * the file exactly like a dialog-inserted one.
 */

export type DiagramLayout =
  | 'list'
  | 'process'
  | 'cycle'
  | 'hierarchy'
  | 'relationship'
  | 'pyramid'
  | 'matrix';

export interface DerivedDiagramSpec {
  layout: DiagramLayout;
  /** Node labels, 2–6 items (SmartArt layouts use up to 6). */
  items: string[];
  /** Human title, e.g. "Process diagram". */
  title: string;
}

const LAYOUT_NAMES: Record<DiagramLayout, string> = {
  list: 'List',
  process: 'Process',
  cycle: 'Cycle',
  hierarchy: 'Hierarchy',
  relationship: 'Relationship',
  pyramid: 'Pyramid',
  matrix: 'Matrix',
};

function cleanItem(raw: string): string {
  let t = raw
    .trim()
    .replace(/^["'(\[]+|["')\]]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Trailing in-sheet phrasing the user stated as placement, not content.
  t = t.replace(/\s+in\s+(the\s+|this\s+|that\s+)?(sheet|workbook)\s*$/i, '').trim();
  t = t.replace(/\s+diagram\s*$/i, '').trim();
  return t;
}

function titleCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function deriveLayout(text: string): DiagramLayout {
  if (/\b(hierarchy|org\s+chart|organisation|organization|reporting|team\s+structure)\b/.test(text)) {
    return 'hierarchy';
  }
  if (/\b(cycle|loop|recurring|continuous)\b/.test(text)) return 'cycle';
  if (/\bpyramid\b/.test(text)) return 'pyramid';
  if (/\bmatrix\b/.test(text)) return 'matrix';
  if (/\b(relationship|compare|comparison|venn)\b/.test(text)) return 'relationship';
  if (/\blist\b/.test(text)) return 'list';
  // Default mirrors the SmartArt dialog default.
  return 'process';
}

function deriveItems(prompt: string): string[] {
  // 1. Arrow chain: "Lead -> Prospect -> Close" (a leading "…: " or
  // "… showing " prefix on the first segment is prompt scaffolding,
  // not a node label).
  if (/(?:->|=>|→)/.test(prompt)) {
    const parts = prompt.split(/\s*(?:->|=>|→)\s*/);
    const first = parts[0].includes(':')
      ? (parts[0].slice(parts[0].lastIndexOf(':') + 1) ?? '')
      : parts[0].replace(/^.*?\b(diagram|showing|with)\b\s*/i, '');
    const items = [cleanItem(first), ...parts.slice(1).map(cleanItem)].filter(Boolean);
    if (items.length >= 2) return items.slice(0, 6);
  }
  // 2. "from X to Y".
  const fromTo = /from\s+(.+?)\s+to\s+([^,;.!?]+)/i.exec(prompt);
  if (fromTo) {
    const items = [titleCase(cleanItem(fromTo[1])), titleCase(cleanItem(fromTo[2]))].filter(Boolean);
    if (items.length >= 2) return items.slice(0, 6);
  }
  // 3. Colon list: "steps: A, B, C".
  const colon = /:\s*([^.!?]+)$/.exec(prompt.trim());
  if (colon) {
    const parts = colon[1]
      .split(/\s*,\s*|\s+and\s+/)
      .map(cleanItem)
      .filter(Boolean);
    if (parts.length >= 2) return parts.slice(0, 6);
  }
  // 4. Dialog defaults.
  return ['Step 1', 'Step 2', 'Step 3', 'Step 4'];
}

export function deriveDiagramSpec(prompt: string): DerivedDiagramSpec {
  const layout = deriveLayout(prompt.toLowerCase());
  const items = deriveItems(prompt);
  return { layout, items, title: `${LAYOUT_NAMES[layout]} diagram` };
}
