/**
 * GAP-9: native XLSX page-setup round-trip.
 *
 * Print areas, margins, headers/footers, and page setup (orientation,
 * paper size, fit-to-page) must survive open → save → re-open. SheetJS CE
 * drops <pageMargins>, <headerFooter> and the _xlnm print defined names,
 * so the adapter parses/injects them directly on the OOXML package.
 *
 * Run: npx vitest run tests/pageSetupXml.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  XlsxAdapter,
  PAGE_SETUP_APP_META_PREFIX,
  PRINT_TITLES_APP_META_PREFIX,
  hasPageSetupSettings,
  injectSheetPageSetup,
  mergeSheetPageSetup,
  readSheetPageSetup,
  sheetPageSetupToAppModel,
  type SheetPageSetup,
} from '../src/index.js';

const REAL_WORLD = join(dirname(fileURLToPath(import.meta.url)), '../../../test-data/real-world');
const FORMATS_FILE = join(REAL_WORLD, 'closedxml-xlsx-formats.xlsx');

function appModelData(): WorkbookData {
  return {
    sheets: [{ name: 'Data', rows: [[1, 2], [3, 4]] }],
    // Simulates what the web app's buildDownloadBytes puts in metadata:
    // the Page Setup dialog model + print titles (no native baseline).
    metadata: {
      [`${PAGE_SETUP_APP_META_PREFIX}Data`]: {
        orientation: 'landscape',
        paperSize: 'a4',
        margins: { top: 1, right: 0.5, bottom: 1, left: 0.5 },
        scale: 80,
        printArea: 'A1:D20',
        header: '&C&D',
        footer: 'Page &P',
        fitToPage: false,
        fitToWidth: 0,
        fitToHeight: 0,
      },
      [`${PRINT_TITLES_APP_META_PREFIX}Data`]: { rows: '1:3', cols: 'A:C' },
    },
  };
}

async function sheetXml(bytes: Uint8Array, sheetFile: string): Promise<string> {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(bytes.slice()) as Record<string, Uint8Array>;
  const key = Object.keys(files).find((k) => k.endsWith(`/${sheetFile}`));
  if (!key) throw new Error(`missing ${sheetFile}`);
  return new TextDecoder().decode(files[key]);
}

describe('pageSetupXml', () => {
  it('writes native <pageSetup>/<pageMargins>/<headerFooter> from the app model', async () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write(appModelData());
    const xml = await sheetXml(bytes, 'sheet1.xml');
    expect(xml).toContain('<pageSetup orientation="landscape" paperSize="9" scale="80"');
    expect(xml).toContain('<pageMargins left="0.5" right="0.5" top="1" bottom="1"');
    expect(xml).toContain('<oddHeader>&amp;C&amp;D</oddHeader>');
    expect(xml).toContain('<oddFooter>Page &amp;P</oddFooter>');
    // Setup elements precede rowBreaks/colBreaks per schema order.
    expect(xml.indexOf('<pageSetup')).toBeLessThan(xml.indexOf('</worksheet>'));

    const { unzipSync } = await import('fflate');
    const files = unzipSync(bytes.slice()) as Record<string, Uint8Array>;
    const wb = new TextDecoder().decode(files['xl/workbook.xml']);
    expect(wb).toContain('<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$D$20</definedName>');
    expect(wb).toContain(
      '<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$3,Data!$A:$C</definedName>',
    );
  });

  it('round-trips the app model through write → read', () => {
    const adapter = new XlsxAdapter();
    const back = adapter.read(adapter.write(appModelData()));
    expect(back.metadata[`${PAGE_SETUP_APP_META_PREFIX}Data`]).toEqual({
      orientation: 'landscape',
      paperSize: 'a4',
      margins: { top: 1, right: 0.5, bottom: 1, left: 0.5 },
      scale: 80,
      printArea: 'A1:D20',
      header: '&C&D',
      footer: 'Page &P',
      fitToPage: false,
      fitToWidth: 0,
      fitToHeight: 0,
    });
    expect(back.metadata[`${PRINT_TITLES_APP_META_PREFIX}Data`]).toEqual({ rows: '1:3', cols: 'A:C' });
    // The native model keeps the exact paper index and raw defined names.
    const native = back.metadata['xlsx.pageSetup.Data'] as SheetPageSetup;
    expect(native.paperSize).toBe(9);
    expect(native.printArea).toBe('Data!$A$1:$D$20');
    expect(native.printTitleRows).toBe('Data!$1:$3');
    expect(native.printTitleCols).toBe('Data!$A:$C');
  });

  it('round-trips fit-to-page through the app model', () => {
    const adapter = new XlsxAdapter();
    const data = appModelData();
    const appModel = data.metadata[`${PAGE_SETUP_APP_META_PREFIX}Data`] as Record<string, unknown>;
    appModel.fitToPage = true;
    appModel.fitToWidth = 1;
    appModel.fitToHeight = 1;
    const back = adapter.read(adapter.write(data));
    const native = back.metadata['xlsx.pageSetup.Data'] as SheetPageSetup;
    expect(native.fitToPage).toBe(true);
    expect(native.fitToWidth).toBe(1);
    expect(native.fitToHeight).toBe(1);
    expect(
      (back.metadata[`${PAGE_SETUP_APP_META_PREFIX}Data`] as Record<string, unknown>).fitToPage,
    ).toBe(true);
  });

  it('round-trips a real Excel file with print settings (read → write → read)', () => {
    const adapter = new XlsxAdapter();
    const original = new Uint8Array(readFileSync(FORMATS_FILE));
    const data = adapter.read(original);

    // Sheet1: A4, fit-to-page, custom margins, header/footer codes.
    const native = data.metadata['xlsx.pageSetup.Sheet1'] as SheetPageSetup;
    expect(native.orientation).toBe('portrait');
    expect(native.paperSize).toBe(9);
    expect(native.fitToPage).toBe(false); // fitToPage attr absent; fitToWidth/Height set
    expect(native.fitToWidth).toBe(1);
    expect(native.fitToHeight).toBe(1);
    expect(native.margins.left).toBeCloseTo(0.7875, 10);
    expect(native.margins.top).toBeCloseTo(1.025, 10);
    expect(native.headerFooter?.oddHeader).toBe('&C&A');
    expect(native.headerFooter?.oddFooter).toBe('&CPage &P');
    // The dialog model is seeded from the native settings.
    expect(data.metadata[`${PAGE_SETUP_APP_META_PREFIX}Sheet1`]).toMatchObject({
      orientation: 'portrait',
      paperSize: 'a4',
      scale: 100,
      header: '&C&A',
    });
    // Sheet4's header carries quoted font names (entity handling).
    const s4 = data.metadata['xlsx.pageSetup.Sheet4'] as SheetPageSetup;
    expect(s4.headerFooter?.oddHeader).toBe('&C&"Times New Roman,Regular"&12&A');

    const resaved = adapter.write(data);
    const back = adapter.read(resaved);
    expect(back.metadata['xlsx.pageSetup.Sheet1']).toEqual(data.metadata['xlsx.pageSetup.Sheet1']);
    expect(back.metadata['xlsx.pageSetup.Sheet4']).toEqual(data.metadata['xlsx.pageSetup.Sheet4']);
    expect(back.metadata[`${PAGE_SETUP_APP_META_PREFIX}Sheet1`]).toEqual(
      data.metadata[`${PAGE_SETUP_APP_META_PREFIX}Sheet1`],
    );
  });

  it('is idempotent across repeated saves', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(new Uint8Array(readFileSync(FORMATS_FILE)));
    const once = adapter.write(data);
    const twice = adapter.write(adapter.read(once));
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
  });

  it('applies dialog edits while preserving untouched native detail', () => {
    const adapter = new XlsxAdapter();
    const data = adapter.read(new Uint8Array(readFileSync(FORMATS_FILE)));
    // Simulate the user changing only the margins in the Page Setup dialog.
    const appModel = {
      ...(data.metadata[`${PAGE_SETUP_APP_META_PREFIX}Sheet1`] as Record<string, unknown>),
      margins: { top: 2, right: 2, bottom: 2, left: 2 },
    };
    data.metadata[`${PAGE_SETUP_APP_META_PREFIX}Sheet1`] = appModel;
    const back = adapter.read(adapter.write(data));
    const native = back.metadata['xlsx.pageSetup.Sheet1'] as SheetPageSetup;
    expect(native.margins.top).toBe(2);
    expect(native.margins.left).toBe(2);
    // Untouched native detail survives: exact paper index, fit-to-page,
    // header/footer codes, odd/even flags.
    expect(native.paperSize).toBe(9);
    expect(native.fitToWidth).toBe(1);
    expect(native.headerFooter?.oddHeader).toBe('&C&A');
    expect(native.headerFooter?.differentOddEven).toBe(false);
  });

  it('clears the print area when the dialog empties it', async () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write(appModelData());
    const data = adapter.read(bytes);
    expect(data.metadata['xlsx.pageSetup.Data']).toBeDefined();
    (data.metadata[`${PAGE_SETUP_APP_META_PREFIX}Data`] as Record<string, unknown>).printArea = null;
    const resaved = adapter.write(data);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(resaved.slice()) as Record<string, Uint8Array>;
    const wb = new TextDecoder().decode(files['xl/workbook.xml']);
    expect(wb).not.toContain('_xlnm.Print_Area');
    // …but the rest of the setup survives.
    const back = adapter.read(resaved);
    expect((back.metadata['xlsx.pageSetup.Data'] as SheetPageSetup).orientation).toBe('landscape');
  });

  it('parses third-party (openpyxl-style) XML', () => {
    const adapter = new XlsxAdapter();
    const plain = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    const setups = new Map<string, SheetPageSetup>([
      [
        'S',
        {
          orientation: 'landscape',
          paperSize: 9,
          scale: 90,
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          pageOrder: 'overThenDown',
          margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
          headerFooter: {
            differentOddEven: false,
            differentFirst: false,
            oddHeader: '&CReport',
            oddFooter: '',
            evenHeader: '',
            evenFooter: '',
            firstHeader: '',
            firstFooter: '',
          },
          printArea: 'S!$A$1:$B$2',
          printTitleRows: null,
          printTitleCols: null,
        },
      ],
    ]);
    const injected = injectSheetPageSetup(plain, setups);
    const read = readSheetPageSetup(injected);
    expect(read.get('S')).toEqual(setups.get('S'));
    expect(sheetPageSetupToAppModel(read.get('S')!)).toMatchObject({
      orientation: 'landscape',
      paperSize: 'a4',
      printArea: 'A1:B2',
      header: '&CReport',
    });
  });

  it('leaves sheets without settings untouched and never throws on garbage', async () => {
    const adapter = new XlsxAdapter();
    const plain = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    const xml = await sheetXml(plain, 'sheet1.xml');
    expect(xml).not.toContain('<pageSetup');
    expect(xml).not.toContain('<pageMargins');
    expect(readSheetPageSetup(new Uint8Array([1, 2, 3])).size).toBe(0);
    expect(injectSheetPageSetup(new Uint8Array([1, 2, 3]), new Map()).length).toBe(3);
  });

  it('mergeSheetPageSetup maps unknown paper sizes losslessly through native', () => {
    // paperSize 3 = Tabloid: no app-model label; the native index must
    // still round-trip even though the dialog shows 'letter'.
    const native: SheetPageSetup = {
      orientation: 'portrait',
      paperSize: 3,
      scale: 100,
      fitToPage: false,
      fitToWidth: 0,
      fitToHeight: 0,
      pageOrder: 'downThenOver',
      margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
      headerFooter: null,
      printArea: null,
      printTitleRows: null,
      printTitleCols: null,
    };
    expect(hasPageSetupSettings(native)).toBe(true);
    const merged = mergeSheetPageSetup(native, sheetPageSetupToAppModel(native), null, 'S');
    expect(merged?.paperSize).toBe(3);
  });
});
