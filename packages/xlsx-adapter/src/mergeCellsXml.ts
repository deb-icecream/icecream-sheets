/**
 * Native merge-cells round-trip (`<mergeCells><mergeCell ref="…"/>`,
 * ISO/IEC 29500 §18.3.1.55; audit §14.3).
 *
 * The model is `SheetData.merges`: an array of A1 range refs in canonical
 * form (uppercase, no `$`), in document order. Only the top-left cell of
 * a merge carries a value — that is the file's own invariant and the
 * parser does not touch cell values.
 *
 * PRECEDENCE (merges vs. the app's session merge model): the app keeps
 * its merges in session state (apps/web features/models.ts MergeRange)
 * and does not read SheetData.merges yet (UI wiring is a later wave).
 * At the FILE layer the rule is single-source: when `SheetData.merges`
 * is present on a sheet handed to the writer — including an empty array,
 * which means "no merges" — it is authoritative and is written as the
 * sheet's `<mergeCells>` element; the classic writer never sets
 * SheetJS's `!merges`, so no second source exists in the package. When
 * the field is absent the writer emits no `<mergeCells>` (a regenerated
 * sheet has no merges to claim). The streaming writer's verbatim tail
 * copy keeps a source file's `<mergeCells>` unless the caller supplies
 * replacement merges via SheetGenOptions (see streamingSave.ts).
 */
import { escapeXmlAttr, findBlock, normalizeRef, splitTopElements } from './nativeXmlUtil.js';

/** Parse `<mergeCells>` from a worksheet XML string. [] when absent. */
export function parseMergeCells(sheetXml: string): string[] {
  const block = findBlock(sheetXml, 'mergeCells');
  if (!block) return [];
  const refs: string[] = [];
  for (const el of splitTopElements(block.inner, 'mergeCell')) {
    const m = /\bref\s*=\s*"([^"]*)"/.exec(el) ?? /\bref\s*=\s*'([^']*)'/.exec(el);
    if (m && m[1]) refs.push(normalizeRef(m[1]));
  }
  return refs;
}

/** Serialize merges to a `<mergeCells>` element ('' when empty). */
export function mergeCellsToXml(merges: readonly string[]): string {
  const refs = merges.map(normalizeRef).filter((r) => r !== '');
  if (refs.length === 0) return '';
  const cells = refs.map((r) => `<mergeCell ref="${escapeXmlAttr(r)}"/>`).join('');
  return `<mergeCells count="${refs.length}">${cells}</mergeCells>`;
}
