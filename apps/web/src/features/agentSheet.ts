/**
 * #146: the sheet name an agent turn (chat or app generation) may report.
 *
 * Two windows produce a bogus 'Sheet1' for a workbook that has none
 * (bxl3way's first sheet is FMTs):
 *
 * (A) Before the open's snapshot lands, the remote host's sheet cache
 * is empty, so the derived active sheet falls back to the literal
 * 'Sheet1' — a name observed nowhere.
 *
 * (B) While the engine session is still hydrating the file, the
 * session itself reports the blank workbook: /sheets answers
 * ['Sheet1'] (timed in proof: blank at 6.3s, real 13 names at 11.5s).
 * That 'Sheet1' IS observed, so a membership check alone cannot catch
 * it — but it is AMBIGUOUS with a genuine blank workbook, and the
 * client cannot tell the two apart.
 *
 * The fix for both: return null, which omits the sheet from the
 * request body and lets the service fall back to the workbook's FIRST
 * sheet at execution time (#135 law). That is correct in every case:
 * a genuine single-Sheet1 workbook resolves to Sheet1 identically;
 * a hydrating bxl3way resolves to FMTs once hydrated (model turns
 * take seconds, so execution normally lands post-hydration); and a
 * multi-sheet workbook still reports its observed active sheet,
 * including a Sheet1 that appears alongside other sheets.
 *
 * The one name the client never asserts is a singleton 'Sheet1':
 * exactly the observation that cannot be trusted.
 */
export function agentSheetFor(
  activeSheet: string,
  visibleSheets: readonly string[],
): string | null {
  if (!visibleSheets.includes(activeSheet)) return null;
  if (visibleSheets.length === 1 && visibleSheets[0] === 'Sheet1') return null;
  return activeSheet;
}
