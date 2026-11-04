/**
 * VBA / Apps Script migration translator (design-docs/automation-lane.md §6).
 *
 * Heuristic, pattern-based translation of common macro patterns into the
 * permissioned automation API. It is NOT a VBA interpreter: each line is
 * matched against the documented pattern set, translated lines become
 * TypeScript over AutomationApi, and anything else is reported verbatim in
 * `untranslated` with an explicit reason instead of being guessed at.
 *
 * Covered patterns:
 *   VBA: Sub/End Sub, Dim, ' comments, Range("A1").Value = x (read+write),
 *     Cells(r,c).Value, Worksheets("S").Range(...) qualifiers,
 *     For i = a To b [Step s] / Next, If/ElseIf/Else/End If, MsgBox -> api.notify.
 *   Apps Script: function (first becomes main), getSheetByName/getActiveSheet,
 *     getRange().setValue/setValues/getValue/getValues,
 *     getUi().alert / Browser.msgBox -> api.notify, var -> let.
 *
 * Explicitly NOT translated (reported, never guessed):
 *   - On Error / error handling, Declare (native API) statements
 *   - With blocks, class modules, UserForms
 *   - Application.* automation beyond the mapped patterns
 *   - Cross-workbook references (Workbooks(...), openById/openByUrl) — v1 out of scope
 *   - Event procedures (Workbook_Open, Worksheet_Change, ...) — migrate these
 *     to automation trigger specs (onOpen/onEdit/onSelectionChange) instead
 *   - External services (UrlFetchApp, GmailApp, DriveApp, ...) — these need
 *     permissioned connectors, which the translator does not provision
 *   - Byte-faithful VBA execution (automation-lane.md §8: out of scope for v1)
 */

import type { DeclaredPermission } from './api.js';

export interface UntranslatedLine {
  line: number;
  text: string;
  reason: string;
}

export interface TranslationResult {
  sourceLanguage: 'vba' | 'apps-script';
  /** Editable TypeScript over the permissioned automation API. */
  code: string;
  /** Permissions the translated script declares. */
  permissions: DeclaredPermission[];
  /** Source lines that were not translated, with reasons. */
  untranslated: UntranslatedLine[];
  /** Human notes for the person finishing the migration. */
  notes: string[];
}

const SCRIPT_HEADER = `import type { AutomationApi, TypedValue } from '@icecream-sheets/service';

/** Unwrap a TypedValue to its raw value (errors become null). */
function v(tv: TypedValue): string | number | boolean | null {
  return tv.kind === 'error' ? null : tv.value;
}

/** A1 address helper: a1("Sheet1", "B2") -> { sheet, row, col }. */
function a1(sheet: string, addr: string): { sheet: string; row: number; col: number } {
  const m = /^([A-Za-z]+)(\\d+)$/.exec(addr.trim());
  if (!m) throw new Error(\`bad A1 address: \${addr}\`);
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheet, row: parseInt(m[2]!, 10) - 1, col: col - 1 };
}

/** A1 range helper: a1range("Sheet1", "A1:B2") -> RangeRef. */
function a1range(
  sheet: string,
  addrs: string,
): { sheet: string; startRow: number; startCol: number; endRow: number; endCol: number } {
  const parts = addrs.split(':');
  const a = a1(sheet, parts[0]!);
  const b = a1(sheet, parts[1] ?? parts[0]!);
  return {
    sheet,
    startRow: Math.min(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endRow: Math.max(a.row, b.row),
    endCol: Math.max(a.col, b.col),
  };
}
`;

interface Ctx {
  out: string[];
  untranslated: UntranslatedLine[];
  notes: string[];
  perms: Map<string, DeclaredPermission>;
  indent: number;
}

function emit(ctx: Ctx, code: string): void {
  ctx.out.push(`${'  '.repeat(ctx.indent)}${code}`);
}

function skip(ctx: Ctx, lineNo: number, text: string, reason: string): void {
  ctx.untranslated.push({ line: lineNo, text: text.trim(), reason });
  if (text.trim().length > 0) emit(ctx, `// NOT TRANSLATED (line ${lineNo}): ${text.trim()}`);
}

function addPerm(ctx: Ctx, action: string, target: string, reason?: string): void {
  const key = `${action} ${target}`;
  if (!ctx.perms.has(key)) ctx.perms.set(key, reason ? { action, target, reason } : { action, target });
}

function newCtx(): Ctx {
  return { out: [], untranslated: [], notes: [], perms: new Map(), indent: 0 };
}

function finish(
  sourceLanguage: 'vba' | 'apps-script',
  ctx: Ctx,
  extraHeader: string[],
): TranslationResult {
  return {
    sourceLanguage,
    code: [SCRIPT_HEADER, ...extraHeader, ...ctx.out, ''].join('\n'),
    permissions: [...ctx.perms.values()],
    untranslated: ctx.untranslated,
    notes: ctx.notes,
  };
}

// ---------------------------------------------------------------------------
// VBA
// ---------------------------------------------------------------------------

const VBA_TYPE_MAP: Record<string, string> = {
  integer: 'number',
  long: 'number',
  single: 'number',
  double: 'number',
  currency: 'number',
  string: 'string',
  boolean: 'boolean',
  variant: 'unknown',
  range: 'unknown',
};

const VBA_EVENT_PROCS = new Set([
  'workbook_open',
  'workbook_beforesave',
  'worksheet_change',
  'worksheet_selectionchange',
  'worksheet_activate',
  'workbook_sheetchange',
]);

/**
 * Rewrite inline VBA value reads inside an expression:
 *   Range("A1").Value      -> v(api.getCell(a1(SHEET, "A1")))
 *   Cells(r, c).Value      -> v(api.getCell({ sheet: SHEET, row: (r)-1, col: (c)-1 }))
 *   Worksheets("S").Range("A1").Value -> sheet-qualified variant
 */
function rewriteVbaReads(expr: string, sheet: string): string {
  return expr
    .replace(
      /Worksheets\("([^"]+)"\)\.Range\("([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)"\)\.Value/gi,
      (_m, s: string, a: string) =>
        a.includes(':')
          ? `api.getRange(a1range(${JSON.stringify(s)}, ${JSON.stringify(a)}))`
          : `v(api.getCell(a1(${JSON.stringify(s)}, ${JSON.stringify(a)})))`,
    )
    .replace(
      /Range\("([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)"\)\.Value/gi,
      (_m, a: string) =>
        a.includes(':')
          ? `api.getRange(a1range(${JSON.stringify(sheet)}, ${JSON.stringify(a)}))`
          : `v(api.getCell(a1(${JSON.stringify(sheet)}, ${JSON.stringify(a)})))`,
    )
    .replace(
      /Cells\(\s*([^,]+?)\s*,\s*(.+?)\s*\)\.Value/gi,
      (_m, r: string, c: string) =>
        `v(api.getCell({ sheet: ${JSON.stringify(sheet)}, row: (${r}) - 1, col: (${c}) - 1 }))`,
    );
}

export function translateVba(source: string): TranslationResult {
  const ctx = newCtx();
  const lines = source.split(/\r?\n/);
  let inSub = false;
  let skipWithDepth = 0;

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (line.length === 0) return;

    // With blocks: explicitly out of scope — skip the whole block.
    if (/^With\b/i.test(line)) {
      skipWithDepth++;
      skip(ctx, lineNo, raw, 'With blocks are not translated (out of scope)');
      return;
    }
    if (/^End\s+With/i.test(line)) {
      skipWithDepth = Math.max(0, skipWithDepth - 1);
      return;
    }
    if (skipWithDepth > 0) {
      skip(ctx, lineNo, raw, 'inside an untranslated With block');
      return;
    }

    let m: RegExpMatchArray | null;

    if ((m = /^(?:Private\s+|Public\s+)?Sub\s+(\w+)\s*\(/i.exec(line))) {
      const name = m[1]!;
      if (VBA_EVENT_PROCS.has(name.toLowerCase())) {
        skip(
          ctx,
          lineNo,
          raw,
          `event procedure ${name}: migrate to an automation trigger spec ` +
            `(onOpen / onEdit / onSelectionChange) instead of translating`,
        );
        ctx.notes.push(
          `Event procedure ${name} was not translated; recreate it as a trigger spec.`,
        );
        return;
      }
      if (inSub) {
        skip(ctx, lineNo, raw, 'nested Sub procedures are not translated');
        return;
      }
      inSub = true;
      emit(ctx, `export function main(api: AutomationApi): void {`);
      ctx.indent++;
      return;
    }
    if (/^End\s+Sub/i.test(line)) {
      if (inSub) {
        ctx.indent = Math.max(0, ctx.indent - 1);
        emit(ctx, `}`);
        inSub = false;
      }
      return;
    }
    if (/^Function\s+\w+/i.test(line) || /^End\s+Function/i.test(line)) {
      skip(ctx, lineNo, raw, 'VBA Function procedures are not translated (inline the logic or rewrite as a helper)');
      return;
    }
    if (!inSub) {
      if (/^(Option|Attribute)\b/i.test(line)) return; // module boilerplate
      skip(ctx, lineNo, raw, 'outside any Sub procedure — only Sub bodies are translated');
      return;
    }

    if ((m = /^Dim\s+(\w+)\s+As\s+(\w+)/i.exec(line))) {
      const tsType = VBA_TYPE_MAP[m[2]!.toLowerCase()] ?? 'unknown';
      emit(ctx, tsType === 'unknown' ? `let ${m[1]};` : `let ${m[1]}: ${tsType};`);
      return;
    }
    if (/^Dim\s+/i.test(line)) {
      skip(ctx, lineNo, raw, 'unsupported Dim declaration (only "Dim x As <type>" is translated)');
      return;
    }
    if ((m = /^'\s?(.*)$/.exec(line))) {
      emit(ctx, `// ${m[1] ?? ''}`);
      return;
    }
    if (/^On\s+Error\b/i.test(line)) {
      skip(ctx, lineNo, raw, 'error handling (On Error) has no automation equivalent and is not translated');
      return;
    }
    if (/^Declare\b/i.test(line)) {
      skip(ctx, lineNo, raw, 'Declare statements (native API calls) cannot be migrated');
      return;
    }
    if (/\bWorkbooks?\s*\(/i.test(line) || /\bActiveWorkbook\b/i.test(line)) {
      skip(ctx, lineNo, raw, 'cross-workbook references are out of scope for v1 (automation-lane.md §8)');
      return;
    }
    if (/\bApplication\./i.test(line)) {
      skip(ctx, lineNo, raw, 'Application.* automation is not translated (only Range/Cells/MsgBox patterns are)');
      return;
    }
    if ((m = /^For\s+(\w+)\s*=\s*(.+?)\s+To\s+(.+?)(?:\s+Step\s+(.+))?\s*$/i.exec(line))) {
      const [, v, from, to, step] = m;
      const fromJs = rewriteVbaReads(from!, 'Sheet1');
      const toJs = rewriteVbaReads(to!, 'Sheet1');
      const incr = step ? `${v} += (${rewriteVbaReads(step, 'Sheet1')})` : `${v}++`;
      emit(ctx, `for (let ${v} = ${fromJs}; ${v} <= (${toJs}); ${incr}) {`);
      ctx.indent++;
      ctx.notes.push('For loops translated with 1-based VBA bounds preserved; Cells() indexes adjusted to 0-based.');
      return;
    }
    if (/^Next(\s+\w+)?$/i.test(line)) {
      ctx.indent = Math.max(0, ctx.indent - 1);
      emit(ctx, `}`);
      return;
    }
    if ((m = /^If\s+(.+?)\s+Then\s*$/i.exec(line))) {
      emit(ctx, `if (${rewriteVbaReads(m[1]!, 'Sheet1')}) {`);
      ctx.indent++;
      return;
    }
    if ((m = /^ElseIf\s+(.+?)\s+Then\s*$/i.exec(line))) {
      ctx.indent = Math.max(0, ctx.indent - 1);
      emit(ctx, `} else if (${rewriteVbaReads(m[1]!, 'Sheet1')}) {`);
      ctx.indent++;
      return;
    }
    if (/^Else\s*$/i.test(line)) {
      ctx.indent = Math.max(0, ctx.indent - 1);
      emit(ctx, `} else {`);
      ctx.indent++;
      return;
    }
    if (/^End\s+If/i.test(line)) {
      ctx.indent = Math.max(0, ctx.indent - 1);
      emit(ctx, `}`);
      return;
    }
    if ((m = /^MsgBox\s*\(?\s*(.+?)\s*\)?\s*$/i.exec(line))) {
      emit(ctx, `api.notify(${rewriteVbaReads(m[1]!, 'Sheet1')});`);
      addPerm(ctx, 'ui.notify', 'workbook', 'migrated MsgBox');
      return;
    }
    // Writes: Worksheets("S").Range("A1").Value = expr
    if (
      (m = /^Worksheets\("([^"]+)"\)\.Range\("([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)"\)\.Value\s*=\s*(.+)$/i.exec(line))
    ) {
      const [, sheet, addrs, expr] = m;
      const js = rewriteVbaReads(expr!, sheet!);
      if (addrs!.includes(':')) {
        emit(ctx, `api.setRange(a1range(${JSON.stringify(sheet)}, ${JSON.stringify(addrs)}), ${js});`);
        addPerm(ctx, 'range.write', `${sheet}!${addrs}`);
      } else {
        emit(ctx, `api.setCell(a1(${JSON.stringify(sheet)}, ${JSON.stringify(addrs)}), ${js});`);
        addPerm(ctx, 'cell.write', `${sheet}!${addrs}`);
      }
      return;
    }
    // Writes: Range("A1").Value = expr / Cells(r, c).Value = expr
    if ((m = /^Range\("([A-Za-z]+\d+(?::[A-Za-z]+\d+)?)"\)\.Value\s*=\s*(.+)$/i.exec(line))) {
      const [, addrs, expr] = m;
      const js = rewriteVbaReads(expr!, 'Sheet1');
      if (addrs!.includes(':')) {
        emit(ctx, `api.setRange(a1range("Sheet1", ${JSON.stringify(addrs)}), ${js});`);
        addPerm(ctx, 'range.write', `Sheet1!${addrs}`);
      } else {
        emit(ctx, `api.setCell(a1("Sheet1", ${JSON.stringify(addrs)}), ${js});`);
        addPerm(ctx, 'cell.write', `Sheet1!${addrs}`);
      }
      return;
    }
    if ((m = /^Cells\(\s*([^,]+?)\s*,\s*(.+?)\s*\)\.Value\s*=\s*(.+)$/i.exec(line))) {
      const [, r, c, expr] = m;
      const js = rewriteVbaReads(expr!, 'Sheet1');
      emit(
        ctx,
        `api.setCell({ sheet: "Sheet1", row: (${r}) - 1, col: (${c}) - 1 }, ${js});`,
      );
      addPerm(ctx, 'cell.write', 'Sheet1!Cells()');
      return;
    }
    // Reads: x = Range("A1").Value / x = Cells(r,c).Value
    if ((m = /^(\w+)\s*=\s*(.+)$/.exec(line))) {
      const [, lhs, rhs] = m;
      if (/Range\(|Cells\(|Worksheets\(/i.test(rhs!)) {
        emit(ctx, `${lhs} = ${rewriteVbaReads(rhs!, 'Sheet1')};`);
        return;
      }
      // Plain VBA assignment: keep, translating & string concat.
      emit(ctx, `${lhs} = ${rhs!.replace(/&/g, '+')};`);
      return;
    }

    skip(ctx, lineNo, raw, 'no translation pattern matches this line');
  });

  if (inSub) {
    ctx.indent = Math.max(0, ctx.indent - 1);
    emit(ctx, `}`);
  }
  ctx.notes.push(
    'Unqualified Range/Cells references were bound to "Sheet1"; qualify with Worksheets("...") or edit the sheet names.',
  );
  return finish('vba', ctx, []);
}

// ---------------------------------------------------------------------------
// Apps Script
// ---------------------------------------------------------------------------

/**
 * Split a leading SpreadsheetApp chain into an optional sheet qualifier:
 *   SpreadsheetApp.getActiveSpreadsheet().getSheetByName("S").getRange("A1")
 *   -> { sheet: '"S"' (source expr), rest: '.getRange("A1")...' }
 */
function splitSheetQualifier(chain: string): { sheetExpr: string; rest: string } {
  const m = /^(SpreadsheetApp\.getActiveSpreadsheet\(\)(?:\.getSheetByName\(([^)]+)\))?|SpreadsheetApp\.getActiveSheet\(\))\.?([\s\S]*)$/.exec(
    chain.trim(),
  );
  if (!m) return { sheetExpr: '"Sheet1"', rest: chain };
  const qualifier = m[1]!;
  const rest = m[3] ?? '';
  if (/getActiveSheet\(\)/.test(qualifier)) return { sheetExpr: 'ACTIVE_SHEET', rest };
  const nameM = /\.getSheetByName\(([^)]+)\)/.exec(qualifier);
  if (nameM) return { sheetExpr: nameM[1]!, rest };
  return { sheetExpr: 'ACTIVE_SHEET', rest };
}

export function translateAppsScript(source: string): TranslationResult {
  const ctx = newCtx();
  const lines = source.split(/\r?\n/);
  let mainEmitted = false;
  let needsActiveSheet = false;
  /** Local variables bound to a sheet qualifier, e.g. `var s = ....getSheetByName("D")`. */
  const sheetVars = new Map<string, string>();

  /** Resolve a range-call receiver to { sheetExpr, rest }. */
  const resolveReceiver = (chain: string): { sheetExpr: string; rest: string } => {
    const trimmed = chain.trim();
    const known = sheetVars.get(trimmed);
    if (known !== undefined) return { sheetExpr: known, rest: '' };
    return splitSheetQualifier(trimmed);
  };
  const noteActiveSheet = (sheetExpr: string): void => {
    if (sheetExpr === 'ACTIVE_SHEET') needsActiveSheet = true;
  };

  /** Rewrite Apps Script expressions: nested getValue() reads and var->let. */
  const rewriteAppsScriptExpr = (expr: string): string =>
    expr
      .replace(
        /([\s\S]*?)\.getRange\(\s*"([^"]+)"\s*\)\.getValue\(\s*\)/g,
        (_mm, chain: string, addrs: string) => {
          const { sheetExpr } = resolveReceiver(chain);
          return `v(api.getCell(a1(${sheetExpr}, "${addrs}")))`;
        },
      )
      .replace(/\bvar\b/g, 'let');

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (line.length === 0) return;

    let m: RegExpMatchArray | null;

    if ((m = /^function\s+(\w+)\s*\(([^)]*)\)\s*\{\s*$/.exec(line))) {
      if (!mainEmitted) {
        mainEmitted = true;
        const params = m[2]!.trim();
        emit(ctx, `export function main(api: AutomationApi${params ? `, ${params}` : ''}): void {`);
        ctx.indent++;
      } else {
        emit(ctx, `function ${m[1]}(${m[2] ?? ''}): void {`);
        ctx.indent++;
      }
      return;
    }
    // Block structure: keep JS as-is (var -> let), tracking braces so the
    // generated code stays balanced. Leading '}' dedents before emitting.
    if (/^(for|if|while|switch)\s*\(/.test(line) || /^\}/.test(line)) {
      const text = line.replace(/\bvar\b/g, 'let');
      if (/^\}/.test(text)) ctx.indent = Math.max(0, ctx.indent - 1);
      emit(ctx, text);
      if (/\{\s*$/.test(text)) ctx.indent++;
      return;
    }
    if (/^\/\//.test(line)) {
      emit(ctx, line);
      return;
    }
    if (/\b(UrlFetchApp|GmailApp|DriveApp|CalendarApp|SlidesApp|DocsApp|Maps|LanguageApp)\b/.test(line)) {
      skip(
        ctx,
        lineNo,
        raw,
        'external Google services need permissioned connectors, which the v1 translator does not provision',
      );
      return;
    }
    if (/\bopenById\s*\(|\bopenByUrl\s*\(/.test(line)) {
      skip(ctx, lineNo, raw, 'cross-workbook references are out of scope for v1 (automation-lane.md §8)');
      return;
    }
    if (/\bLogger\.log\s*\(/.test(line)) {
      skip(ctx, lineNo, raw, 'Logger.log has no automation equivalent; use api.notify() if user-visible output is intended');
      return;
    }
    // Browser.msgBox("t") / SpreadsheetApp.getUi().alert("t")
    if ((m = /^(?:Browser\.msgBox|SpreadsheetApp\.getUi\(\)\.alert)\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(line))) {
      emit(ctx, `api.notify(${m[1]});`);
      addPerm(ctx, 'ui.notify', 'workbook', 'migrated alert');
      return;
    }
    // var s = SpreadsheetApp...getSheetByName("D") / getActiveSheet():
    // bind the variable to its sheet qualifier for later s.getRange(...) calls.
    if (
      (m = /^(?:var|let|const)\s+(\w+)\s*=\s*(SpreadsheetApp\.getActiveSpreadsheet\(\)[\s\S]*?|SpreadsheetApp\.getActiveSheet\(\))\s*;?\s*$/.exec(line))
    ) {
      const { sheetExpr, rest } = splitSheetQualifier(m[2]!);
      if (rest.trim().length === 0) {
        sheetVars.set(m[1]!, sheetExpr);
        noteActiveSheet(sheetExpr);
        emit(ctx, `// sheet variable "${m[1]}" bound to ${sheetExpr}`);
      } else {
        skip(ctx, lineNo, raw, 'unrecognized SpreadsheetApp chain in sheet assignment');
      }
      return;
    }
    // <chain>.getRange("A1").setValue(expr) / .setValues(expr)
    if (
      (m = /^([\s\S]*?)\.getRange\(\s*"([^"]+)"\s*\)\.(setValue|setValues)\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(line))
    ) {
      const [, chain, addrs, op, expr] = m;
      const { sheetExpr, rest } = resolveReceiver(chain!);
      if (rest.trim().length > 0) {
        skip(ctx, lineNo, raw, 'unrecognized chain between sheet and getRange()');
        return;
      }
      noteActiveSheet(sheetExpr);
      const translatedExpr = rewriteAppsScriptExpr(expr!);
      if (op === 'setValue') {
        emit(ctx, `api.setCell(a1(${sheetExpr}, "${addrs}"), ${translatedExpr});`);
        addPerm(ctx, 'cell.write', `${sheetExpr}!${addrs}`);
      } else {
        emit(ctx, `api.setRange(a1range(${sheetExpr}, "${addrs}"), ${translatedExpr});`);
        addPerm(ctx, 'range.write', `${sheetExpr}!${addrs}`);
      }
      return;
    }
    // var x = <chain>.getRange("A1").getValue() / .getValues()
    if (
      (m = /^(?:var|let|const)\s+(\w+)\s*=\s*([\s\S]*?)\.getRange\(\s*"([^"]+)"\s*\)\.(getValue|getValues)\(\s*\)\s*;?\s*$/.exec(line))
    ) {
      const [, name, chain, addrs, op] = m;
      const { sheetExpr, rest } = resolveReceiver(chain!);
      if (rest.trim().length > 0) {
        skip(ctx, lineNo, raw, 'unrecognized chain between sheet and getRange()');
        return;
      }
      noteActiveSheet(sheetExpr);
      if (op === 'getValue') {
        emit(ctx, `let ${name} = v(api.getCell(a1(${sheetExpr}, "${addrs}")));`);
        addPerm(ctx, 'cell.read', `${sheetExpr}!${addrs}`);
      } else {
        emit(
          ctx,
          `let ${name} = api.getRange(a1range(${sheetExpr}, "${addrs}")).map((r) => r.map(v));`,
        );
        addPerm(ctx, 'range.read', `${sheetExpr}!${addrs}`);
      }
      return;
    }
    // for (...) / if (...) / other JS: keep, rewriting var -> let.
    if (/^(for|if|while|switch)\s*\(/.test(line) || /^\}\s*(else|catch)/.test(line)) {
      emit(ctx, line.replace(/\bvar\b/g, 'let'));
      if (/\{\s*$/.test(line)) ctx.indent++;
      return;
    }
    if (/\bvar\b/.test(line)) {
      emit(ctx, rewriteAppsScriptExpr(line));
      return;
    }
    // Fallback: Apps Script is JavaScript, so plain JS statements pass
    // through (var -> let). Unrecognized SpreadsheetApp service usage is
    // reported rather than passed through, so nothing silently misbehaves.
    if (/SpreadsheetApp\./.test(line)) {
      skip(ctx, lineNo, raw, 'unrecognized SpreadsheetApp usage is not translated');
      return;
    }
    emit(ctx, line.replace(/\bvar\b/g, 'let'));
  });

  const header: string[] = [];
  if (needsActiveSheet) {
    header.push(`/** The script's active sheet: set this to the sheet the macro ran against. */`);
    header.push(`const ACTIVE_SHEET = "Sheet1";`, ``);
    ctx.notes.push('getActiveSheet() was bound to const ACTIVE_SHEET — set it to the intended sheet.');
  }
  ctx.notes.push(
    'Only the first function becomes main(api); other functions are kept as plain helpers.',
  );
  return finish('apps-script', ctx, header);
}

/** Rewrite Apps Script expressions: nested getValue() reads and var->let. */
