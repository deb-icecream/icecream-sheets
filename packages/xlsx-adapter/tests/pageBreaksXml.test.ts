import { describe, expect, it } from 'vitest';
import type { WorkbookData } from '@icecream-sheets/engine';
import {
  XlsxAdapter,
  PAGE_BREAKS_META_PREFIX,
  injectSheetPageBreaks,
  readSheetPageBreaks,
} from '../src/index.js';

function workbookData(): WorkbookData {
  const rows = Array.from({ length: 30 }, (_, r) =>
    Array.from({ length: 10 }, (_, c) => `R${r + 1}C${c + 1}`),
  );
  return {
    sheets: [
      { name: 'Data', rows },
      { name: 'Other', rows: [[1, 2], [3, 4]] },
    ],
    metadata: {
      [`${PAGE_BREAKS_META_PREFIX}Data`]: { rows: [9, 19], cols: [4] },
    },
  };
}

describe('pageBreaksXml', () => {
  it('round-trips manual breaks through write → read', () => {
    const adapter = new XlsxAdapter();
    const bytes = adapter.write(workbookData());
    const back = adapter.read(bytes);
    expect(back.metadata[`${PAGE_BREAKS_META_PREFIX}Data`]).toEqual({ rows: [9, 19], cols: [4] });
    // The sheet without breaks gets no metadata entry.
    expect(back.metadata[`${PAGE_BREAKS_META_PREFIX}Other`]).toBeUndefined();
  });

  it('writes native <rowBreaks>/<colBreaks> XML that Excel understands', async () => {
    const { unzipSync } = await import('fflate');
    const adapter = new XlsxAdapter();
    const bytes = adapter.write(workbookData());
    const files = unzipSync(bytes.slice()) as Record<string, Uint8Array>;
    const key = Object.keys(files).find((k) => /worksheets\/sheet1\.xml$/.test(k))!;
    const text = new TextDecoder().decode(files[key]);
    // Break after 0-based row 9 → new page at 1-based row 11 → brk id 11.
    expect(text).toContain('<rowBreaks');
    expect(text).toContain('<brk id="11"');
    expect(text).toContain('<brk id="21"');
    expect(text).toContain('<colBreaks');
    expect(text).toContain('<brk id="6"');
    expect(text).toContain('man="1"');
  });

  it('reads breaks authored by a third party (openpyxl-style XML)', () => {
    const adapter = new XlsxAdapter();
    const plain = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    const breaks = new Map([['S', { rows: [4], cols: [1] }]]);
    const injected = injectSheetPageBreaks(plain, breaks);
    const read = readSheetPageBreaks(injected);
    expect(read.get('S')).toEqual({ rows: [4], cols: [1] });
  });

  it('ignores automatic breaks (man missing or man="0") on read', async () => {
    const { unzipSync, zipSync } = await import('fflate');
    const adapter = new XlsxAdapter();
    const plain = adapter.write({ sheets: [{ name: 'S', rows: [[1]] }], metadata: {} });
    const withManual = injectSheetPageBreaks(plain, new Map([['S', { rows: [2], cols: [] }]]));
    // Sanity: manual breaks are found.
    expect(readSheetPageBreaks(withManual).get('S')).toEqual({ rows: [2], cols: [] });
    // Strip man="1" from the worksheet XML → automatic break → ignored.
    const files = unzipSync(withManual.slice()) as Record<string, Uint8Array>;
    const key = Object.keys(files).find((k) => /worksheets\/sheet1\.xml$/.test(k))!;
    const xml = new TextDecoder().decode(files[key]).replace(/ man="1"/g, '');
    files[key] = new TextEncoder().encode(xml);
    expect(readSheetPageBreaks(zipSync(files)).get('S')).toBeUndefined();
  });

  it('native XML wins over stale custom-property metadata on read', async () => {
    const { unzipSync, zipSync } = await import('fflate');
    const adapter = new XlsxAdapter();
    // Icecream writes breaks [9]: native XML (id 11) + custom prop ([9]).
    const bytes = adapter.write(workbookData());
    // Simulate an Excel edit: the user moves the break to after row 4
    // (brk id 6) in Excel; the custom property still says [9].
    const files = unzipSync(bytes.slice()) as Record<string, Uint8Array>;
    const key = Object.keys(files).find((k) => /worksheets\/sheet1\.xml$/.test(k))!;
    const xml = new TextDecoder().decode(files[key]).replace('<brk id="11"', '<brk id="6"');
    files[key] = new TextEncoder().encode(xml);
    const edited = zipSync(files);
    const back = adapter.read(edited);
    // The native XML (break after row 4) is authoritative, not the stale [9].
    expect(back.metadata[`${PAGE_BREAKS_META_PREFIX}Data`]).toEqual({ rows: [4, 19], cols: [4] });
  });

  it('never fails the save on malformed break metadata', () => {
    const adapter = new XlsxAdapter();
    const data = workbookData();
    data.metadata[`${PAGE_BREAKS_META_PREFIX}Data`] = { rows: 'junk', cols: [-1, 2.5, 3] };
    const bytes = adapter.write(data);
    const back = adapter.read(bytes);
    expect(back.metadata[`${PAGE_BREAKS_META_PREFIX}Data`]).toEqual({ rows: [], cols: [3] });
  });

  it('is idempotent across repeated saves', async () => {
    const adapter = new XlsxAdapter();
    const once = adapter.write(workbookData());
    const back = adapter.read(once);
    const twice = adapter.write(back);
    const reread = adapter.read(twice);
    expect(reread.metadata[`${PAGE_BREAKS_META_PREFIX}Data`]).toEqual({ rows: [9, 19], cols: [4] });
    // Exactly one rowBreaks element per save (no duplication).
    const { unzipSync } = await import('fflate');
    const files = unzipSync(twice.slice()) as Record<string, Uint8Array>;
    const key = Object.keys(files).find((k) => /worksheets\/sheet1\.xml$/.test(k))!;
    const text = new TextDecoder().decode(files[key]);
    const matches = text.match(/<rowBreaks/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
