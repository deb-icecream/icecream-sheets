/**
 * Tests for the VBA / Apps Script migration translator: the documented
 * pattern set translates, and everything else is reported verbatim with
 * an explicit reason (never guessed).
 */
import { describe, expect, it } from 'vitest';
import { translateAppsScript, translateVba } from '../src/index.js';

describe('translateVba', () => {
  const source = [
    'Sub FillTotals()',
    '    Dim i As Integer',
    '    Dim total As Double',
    "    ' Sum the first ten rows",
    '    total = 0',
    '    For i = 1 To 10',
    '        total = total + Cells(i, 1).Value',
    '    Next i',
    '    Range("B1").Value = total',
    '    If total > 100 Then',
    '        Range("B2").Value = "big"',
    '    End If',
    '    MsgBox "Done"',
    'End Sub',
  ].join('\n');

  it('translates the common pattern set', () => {
    const result = translateVba(source);
    expect(result.sourceLanguage).toBe('vba');
    expect(result.untranslated).toEqual([]);
    const { code } = result;
    expect(code).toContain('export function main(api: AutomationApi): void {');
    expect(code).toContain('let i: number;');
    expect(code).toContain('let total: number;');
    expect(code).toContain('// Sum the first ten rows');
    expect(code).toContain('for (let i = 1; i <= (10); i++) {');
    expect(code).toContain('v(api.getCell({ sheet: "Sheet1", row: (i) - 1, col: (1) - 1 }))');
    expect(code).toContain('api.setCell(a1("Sheet1", "B1"), total);');
    expect(code).toContain('if (total > 100) {');
    expect(code).toContain('api.notify("Done");');
  });

  it('collects declared permissions', () => {
    const result = translateVba(source);
    const actions = result.permissions.map((p) => p.action);
    expect(actions).toContain('cell.write');
    expect(actions).toContain('ui.notify');
  });

  it('reports untranslatable lines with reasons instead of guessing', () => {
    const result = translateVba(
      [
        'Sub Risky()',
        '    On Error Resume Next',
        '    Declare Function GetTickCount Lib "kernel32" () As Long',
        '    Workbooks("other.xlsx").Sheets(1).Range("A1").Value = 1',
        '    Application.ScreenUpdating = False',
        '    With Range("A1")',
        '        .Font.Bold = True',
        '    End With',
        'End Sub',
      ].join('\n'),
    );
    const reasons = result.untranslated.map((u) => u.reason);
    expect(reasons.some((r) => r.includes('On Error'))).toBe(true);
    expect(reasons.some((r) => r.includes('Declare'))).toBe(true);
    expect(reasons.some((r) => r.includes('cross-workbook'))).toBe(true);
    expect(reasons.some((r) => r.includes('Application'))).toBe(true);
    expect(reasons.some((r) => r.includes('With blocks'))).toBe(true);
  });

  it('redirects event procedures to trigger specs', () => {
    const result = translateVba(
      ['Private Sub Worksheet_Change(ByVal Target As Range)', '    MsgBox "changed"', 'End Sub'].join(
        '\n',
      ),
    );
    expect(result.untranslated.length).toBeGreaterThan(0);
    expect(result.untranslated[0]!.reason).toMatch(/trigger spec/);
    expect(result.notes.some((n) => n.includes('Worksheet_Change'))).toBe(true);
  });

  it('handles Worksheets-qualified references and ElseIf', () => {
    const result = translateVba(
      [
        'Sub Q()',
        '    Dim x As Integer',
        '    x = Worksheets("Data").Range("A1").Value',
        '    If x > 1 Then',
        '        Worksheets("Data").Range("A2").Value = 1',
        '    ElseIf x > 0 Then',
        '        Worksheets("Data").Range("A2").Value = 0',
        '    Else',
        '        Worksheets("Data").Range("A2").Value = -1',
        '    End If',
        'End Sub',
      ].join('\n'),
    );
    expect(result.untranslated).toEqual([]);
    expect(result.code).toContain('x = v(api.getCell(a1("Data", "A1")));');
    expect(result.code).toContain('api.setCell(a1("Data", "A2"), 1);');
    expect(result.code).toContain('} else if (x > 0) {');
    expect(result.code).toContain('} else {');
  });
});

describe('translateAppsScript', () => {
  const source = [
    'function fillReport() {',
    '  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Data");',
    '  var name = sheet.getRange("A1").getValue();',
    '  sheet.getRange("B1").setValue(name);',
    '  sheet.getRange("A2:B3").setValues([[1, 2], [3, 4]]);',
    '  SpreadsheetApp.getUi().alert("done");',
    '}',
  ].join('\n');

  it('translates the common Apps Script pattern set', () => {
    const result = translateAppsScript(source);
    expect(result.sourceLanguage).toBe('apps-script');
    const { code } = result;
    expect(code).toContain('export function main(api: AutomationApi): void {');
    expect(code).toContain('let name = v(api.getCell(a1("Data", "A1")));');
    expect(code).toContain('api.setCell(a1("Data", "B1"), name);');
    expect(code).toContain('api.setRange(a1range("Data", "A2:B3"), [[1, 2], [3, 4]]);');
    expect(code).toContain('api.notify("done");');
    // getSheetByName qualifier is consumed, not left dangling.
    expect(code).not.toContain('getSheetByName');
  });

  it('binds getActiveSheet to an explicit ACTIVE_SHEET const with a note', () => {
    const result = translateAppsScript(
      [
        'function f() {',
        '  SpreadsheetApp.getActiveSheet().getRange("A1").setValue(1);',
        '}',
      ].join('\n'),
    );
    expect(result.code).toContain('const ACTIVE_SHEET = "Sheet1";');
    expect(result.code).toContain('api.setCell(a1(ACTIVE_SHEET, "A1"), 1);');
    expect(result.notes.some((n) => n.includes('ACTIVE_SHEET'))).toBe(true);
  });

  it('keeps plain JS control flow and converts var to let', () => {
    const result = translateAppsScript(
      [
        'function f() {',
        '  var total = 0;',
        '  for (var i = 0; i < 3; i++) {',
        '    total = total + i;',
        '  }',
        '  if (total > 2) {',
        '    Browser.msgBox("big");',
        '  } else {',
        '    Browser.msgBox("small");',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(result.untranslated).toEqual([]);
    expect(result.code).toContain('let total = 0;');
    expect(result.code).toContain('for (let i = 0; i < 3; i++) {');
    expect(result.code).toContain('} else {');
    expect(result.code).toContain('api.notify("big");');
  });

  it('reports external services and cross-workbook refs with reasons', () => {
    const result = translateAppsScript(
      [
        'function f() {',
        '  var r = UrlFetchApp.fetch("https://example.com");',
        '  var ss = SpreadsheetApp.openById("abc");',
        '  Logger.log("x");',
        '}',
      ].join('\n'),
    );
    const reasons = result.untranslated.map((u) => u.reason);
    expect(reasons.some((r) => r.includes('permissioned connectors'))).toBe(true);
    expect(reasons.some((r) => r.includes('cross-workbook'))).toBe(true);
    expect(reasons.some((r) => r.includes('Logger.log'))).toBe(true);
  });
});
