/**
 * GAP-10: native XLSX protection round-trip.
 *
 * The metadata-hint channel (icecream.protection.* custom properties) is
 * covered in adapter.test.ts. These tests cover the NATIVE layer: real
 * <sheetProtection> / <workbookProtection> elements and cell-xf
 * locked/hidden flags must survive open -> save, and files protected in
 * the app must come out as genuinely protected XLSX (Excel honors them).
 * Passwords are never persisted — only the protection STATE travels.
 */
import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import {
  ProtectionManager,
  type CellProtectionFlags,
  type SheetProtectionOptions,
  type WorkbookData,
} from '@icecream-sheets/engine';
import { XlsxAdapter } from '../src/index.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function partsOf(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, data] of Object.entries(unzipSync(bytes.slice()))) {
    if (path.endsWith('.xml') || path.endsWith('.rels')) {
      out[path] = decoder.decode(data as Uint8Array);
    }
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Build workbook data the way the web app's save path does. */
function appStyleData(): { manager: ProtectionManager; data: WorkbookData } {
  const manager = new ProtectionManager();
  manager.protectSheet('Data', 's3cret', { sort: true });
  manager.setLockedRanges('Data', [], ['B2:C3']);
  manager.protectWorkbook(undefined);
  const data: WorkbookData = {
    sheets: [
      {
        name: 'Data',
        rows: [
          ['a', 'b', 'c'],
          ['d', 'e', null],
          ['g', 'h', null],
        ],
      },
    ],
    metadata: { ...manager.toMetadata() },
  };
  return { manager, data };
}

describe('GAP-10 native protection round-trip', () => {
  it('writes native protection XML for an app-protected sheet (no passwords)', () => {
    const adapter = new XlsxAdapter();
    const { data } = appStyleData();
    const bytes = adapter.write(data);
    const parts = partsOf(bytes);

    const sheetXml = parts['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheetXml).toContain('<sheetProtection');
    expect(sheetXml).toContain('sort="1"');
    // Passwords are NEVER stored (design §4): no password attribute anywhere.
    for (const xml of Object.values(parts)) {
      expect(xml).not.toContain('password="');
    }

    const wbXml = parts['xl/workbook.xml'] ?? '';
    expect(wbXml).toContain('<workbookProtection');
    expect(wbXml).toContain('lockStructure="1"');

    // Unlocked cells get locked="0" xf flags; empty unlocked cells are
    // materialized as empty styled <c> elements.
    const stylesXml = parts['xl/styles.xml'] ?? '';
    expect(stylesXml).toContain('<protection locked="0"/>');
    expect(sheetXml).toContain('<c r="C3"');
  });

  it('full loop: protect -> save -> re-open -> flags intact, locked cells still locked', () => {
    const adapter = new XlsxAdapter();
    const { data } = appStyleData();
    const bytes = adapter.write(data);
    const back = adapter.read(bytes);

    const after = new ProtectionManager();
    after.fromMetadata(back.metadata);

    expect(after.isSheetProtected('Data')).toBe(true);
    expect(after.getSheetProtection('Data')?.options.sort).toBe(true);
    // The password itself never travels — hint-only (design §4/§5).
    expect(after.getSheetProtection('Data')?.passwordHash).toBeUndefined();
    // Locked cells are still locked; unlocked ranges stayed editable.
    expect(after.isCellEditable('Data', 0, 0)).toBe(false); // A1 locked
    expect(after.isCellEditable('Data', 1, 1)).toBe(true); // B2 unlocked
    expect(after.isCellEditable('Data', 2, 2)).toBe(true); // C3 unlocked (was empty)
    // Workbook protection survived.
    expect(after.isWorkbookProtected()).toBe(true);
    expect(after.getWorkbookProtection().structure).toBe(true);
    // Unprotected sheets stay unprotected.
    expect(after.isSheetProtected('Other')).toBe(false);
    // Empty unlocked cells did not gain values.
    expect(back.sheets[0]?.rows[2]?.[2]).toBe(null);
  });

  it('second round-trip stays idempotent (no duplicated elements)', () => {
    const adapter = new XlsxAdapter();
    const { data } = appStyleData();
    const once = adapter.write(data);
    const back = adapter.read(once);
    const twice = adapter.write(back);
    const parts = partsOf(twice);
    const sheetXml = parts['xl/worksheets/sheet1.xml'] ?? '';
    expect(countOccurrences(sheetXml, '<sheetProtection')).toBe(1);
    const wbXml = parts['xl/workbook.xml'] ?? '';
    expect(countOccurrences(wbXml, '<workbookProtection')).toBe(1);

    const after = new ProtectionManager();
    after.fromMetadata(adapter.read(twice).metadata);
    expect(after.isSheetProtected('Data')).toBe(true);
    expect(after.isCellEditable('Data', 0, 0)).toBe(false);
    expect(after.isCellEditable('Data', 1, 1)).toBe(true);
  });

  it('reads native protection from an Excel-produced file', () => {
    const adapter = new XlsxAdapter();
    // Base package from the adapter, then hand-inject Excel-style native
    // XML (strict <protection> child + transitional xf attributes).
    const base = adapter.write({
      sheets: [{ name: 'Data', rows: [['a', 'b'], ['c', 'd'], ['e', 'f']] }],
      metadata: {},
    });
    const files = unzipSync(base.slice());
    let sheetXml = decoder.decode(files['xl/worksheets/sheet1.xml'] as Uint8Array);
    sheetXml = sheetXml
      .replace('</sheetData>', '</sheetData><sheetProtection sheet="1" password="9A3F" selectLockedCells="0" sort="1"/>')
      .replace('<c r="B2"', '<c r="B2" s="1"')
      .replace('<c r="A3"', '<c r="A3" s="2"');
    files['xl/worksheets/sheet1.xml'] = encoder.encode(sheetXml);
    let stylesXml = decoder.decode(files['xl/styles.xml'] as Uint8Array);
    stylesXml = stylesXml
      .replace('cellXfs count="1"', 'cellXfs count="3"')
      .replace(
        '</cellXfs>',
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><protection locked="0" hidden="1"/></xf>' +
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" locked="0" applyProtection="1"/></cellXfs>',
      );
    files['xl/styles.xml'] = encoder.encode(stylesXml);
    // Workbook-level protection, Excel style.
    let wbXml = decoder.decode(files['xl/workbook.xml'] as Uint8Array);
    wbXml = wbXml.replace('<sheets>', '<workbookProtection lockStructure="1" lockWindows="1"/><sheets>');
    files['xl/workbook.xml'] = encoder.encode(wbXml);
    const crafted = zipSync(files);

    const data = adapter.read(crafted);
    const sheetMeta = data.metadata['icecream.protection.sheet.Data'] as {
      options: SheetProtectionOptions;
      unlockedRanges: string[];
      hasPassword: boolean;
    };
    expect(sheetMeta).toBeDefined();
    // Excel attr mapping: absent selectLockedCells default true; explicit
    // "0" disables; sort="1" enables; password verifier -> marker only.
    expect(sheetMeta.options.selectLockedCells).toBe(false);
    expect(sheetMeta.options.selectUnlockedCells).toBe(true);
    expect(sheetMeta.options.sort).toBe(true);
    expect(sheetMeta.hasPassword).toBe(true);
    // B2 (strict child form) and A3 (transitional attr form) are unlocked.
    expect(sheetMeta.unlockedRanges).toContain('B2');
    expect(sheetMeta.unlockedRanges).toContain('A3');

    const cellFlags = data.metadata['icecream.protection.cellflags.Data'] as Record<string, CellProtectionFlags>;
    expect(cellFlags['1:1']).toEqual({ locked: false, hidden: true });
    expect(cellFlags['2:0']).toEqual({ locked: false });

    const wbMeta = data.metadata['icecream.protection.workbook'] as {
      structure: boolean;
      windows: boolean;
    };
    expect(wbMeta.structure).toBe(true);
    expect(wbMeta.windows).toBe(true);

    // And the manager enforces it after fromMetadata.
    const manager = new ProtectionManager();
    manager.fromMetadata(data.metadata);
    expect(manager.isSheetProtected('Data')).toBe(true);
    expect(manager.isCellEditable('Data', 1, 1)).toBe(true); // B2 unlocked
    expect(manager.isCellEditable('Data', 2, 0)).toBe(true); // A3 unlocked
    expect(manager.isCellEditable('Data', 0, 0)).toBe(false); // A1 locked
    expect(manager.isWorkbookProtected()).toBe(true);
  });

  it('unprotected sheets produce no protection XML', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write({
      sheets: [{ name: 'S', rows: [[1, 2], [3, 4]] }],
      metadata: {},
    });
    const parts = partsOf(bytes);
    expect(parts['xl/worksheets/sheet1.xml'] ?? '').not.toContain('<sheetProtection');
    expect(parts['xl/workbook.xml'] ?? '').not.toContain('<workbookProtection');
    expect(parts['xl/styles.xml'] ?? '').not.toContain('<protection');
    const back = adapter.read(bytes);
    const manager = new ProtectionManager();
    manager.fromMetadata(back.metadata);
    expect(manager.isSheetProtected('S')).toBe(false);
    expect(manager.isWorkbookProtected()).toBe(false);
  });

  it('cell hidden flags round-trip as fidelity metadata without affecting enforcement', () => {
    const adapter = new XlsxAdapter();
    const before = new ProtectionManager();
    before.protectSheet('S', undefined);
    before.setCellProtectionFlags('S', { '0:0': { hidden: true } });
    const bytes = adapter.write({
      sheets: [{ name: 'S', rows: [['=1+1']] }],
      metadata: { ...before.toMetadata() },
    });
    const parts = partsOf(bytes);
    expect(parts['xl/styles.xml'] ?? '').toContain('<protection hidden="1"/>');

    const after = new ProtectionManager();
    after.fromMetadata(adapter.read(bytes).metadata);
    expect(after.getCellProtectionFlags('S')['0:0']).toEqual({ hidden: true });
    // The xf "hidden" flag is formula-hiding fidelity, NOT face-e hiding:
    // the cell is still locked (not editable) per sheet protection.
    expect(after.isCellEditable('S', 0, 0)).toBe(false);
  });

  it('native XML wins over the custom-property hint when both are present', () => {
    const adapter = new XlsxAdapter();
    // App saved with sort allowed (hint says sort:true); an external edit
    // changed the native XML to disallow sort. Native is newer -> wins.
    const { data } = appStyleData();
    const bytes = adapter.write(data);
    const files = unzipSync(bytes.slice());
    let sheetXml = decoder.decode(files['xl/worksheets/sheet1.xml'] as Uint8Array);
    sheetXml = sheetXml.replace(/<sheetProtection\b[^>]*\/>/g, '<sheetProtection sheet="1"/>');
    files['xl/worksheets/sheet1.xml'] = encoder.encode(sheetXml);
    const edited = zipSync(files);

    const manager = new ProtectionManager();
    manager.fromMetadata(adapter.read(edited).metadata);
    expect(manager.isSheetProtected('Data')).toBe(true);
    expect(manager.getSheetProtection('Data')?.options.sort).toBe(false);
  });

  it('falls back to the custom-property hint when native XML is absent', () => {
    const adapter = new XlsxAdapter();
    // Simulate an app-protected file whose native XML was stripped by an
    // external editor (Excel preserves unknown custom properties).
    const { data } = appStyleData();
    const bytes = adapter.write(data);
    const files = unzipSync(bytes.slice());
    let sheetXml = decoder.decode(files['xl/worksheets/sheet1.xml'] as Uint8Array);
    sheetXml = sheetXml.replace(/<sheetProtection\b[^>]*\/>/g, '');
    files['xl/worksheets/sheet1.xml'] = encoder.encode(sheetXml);
    const stripped = zipSync(files);

    // The custom-property hint still carries the app state (backward
    // compatible: pre-fix app files keep working).
    const back = adapter.read(stripped);
    const manager = new ProtectionManager();
    manager.fromMetadata(back.metadata);
    expect(manager.isSheetProtected('Data')).toBe(true);
  });
});
