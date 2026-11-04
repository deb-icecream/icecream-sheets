/**
 * Defect E2 regression tests (Cycle 10 closure, W10 R1b): saved formats
 * did not RENDER on desktop relaunch.
 *
 * Root cause (traced in hidden_files/cycle10-closure/
 * w12-displaypath-results.md): the main-process summary DID carry the
 * styles (apps/desktop engine-load summarizeSheet, pinned by
 * apps/desktop/tests/engine-load.test.ts) and App's hydration DID seed
 * the FormatStore from them — but openDesktopBuffer called
 * hydrateOpenedWorkbook() BEFORE notifyHostReplaced(), and the
 * host-replaced handler resets the store with
 * setFormats(createFormatStore()). Both are plain-value setState calls
 * in the same batch, so the reset landed last and the seed was wiped:
 * the relaunched grid rendered bold + "0.00%" as fw 400 / plain "0".
 * The gateway and local opens notify first and hydrate second, which
 * is why only the desktop path lost the formats.
 *
 * These tests pin (1) the summary → WorkbookData → FormatStore → CSS /
 * display-text chain the desktop open feeds, using a file shaped like
 * W10's evidence (MONTHLY VIEW (LITE) C10 =ROUND(SUM(C9:N9)-1,4) = 0,
 * bold + "0.00%"), and (2) the load-bearing call order in App.tsx.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { XlsxAdapter, formatWithCode } from '@icecream-sheets/xlsx-adapter';
import type { EngineLoadResult } from '@icecream-sheets/engine';
import { importedFormatsToStore } from './io';
import { workbookDataFromDesktopLoadResult } from './features/localMirror';
import { formatToCSS, getFormat } from './features/formatting';

const SHEET = 'MONTHLY VIEW (LITE)';

function styledFixtureBytes(): Uint8Array {
  const adapter = new XlsxAdapter();
  const rows: unknown[][] = [];
  const row9: unknown[] = [null, null];
  for (let i = 0; i < 12; i++) row9.push(1 / 12); // C9:N9 sums to 1
  rows[8] = row9;
  rows[9] = [null, null, '=ROUND(SUM(C9:N9)-1,4)']; // C10 check cell = 0
  return adapter.write({
    sheets: [
      {
        name: SHEET,
        rows: rows as never,
        styles: { '9:2': { bold: true, numberFormatCode: '0.00%' } },
      },
    ],
    metadata: {},
  });
}

describe('E2: desktop-open format chain (summary → render store)', () => {
  it('seeded styles reach the FormatStore and render as fw 700 / "0.00%"', () => {
    const adapter = new XlsxAdapter();
    const parsed = adapter.read(styledFixtureBytes());
    const parsedSheet = parsed.sheets.find((s) => s.name === SHEET)!;
    // What the main process parsed from the file (pre-IPC state).
    expect(parsedSheet.styles?.['9:2']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    expect(parsedSheet.formats?.['9:2']).toBe('0.00%');

    // The IPC load result, shaped exactly as summarizeSheet builds it
    // (apps/desktop/src/engine-load.ts; pinned there by its own suite).
    const result: EngineLoadResult = {
      sheets: parsed.sheets.map((s) => ({
        name: s.name,
        ...(s.formats ? { formats: { ...s.formats } } : {}),
        ...(s.styles ? { styles: { ...s.styles } } : {}),
      })),
      metadata: parsed.metadata ?? {},
      definedNames: parsed.definedNames,
    };

    // The renderer reconstruction openDesktopBuffer hydrates from.
    const data = workbookDataFromDesktopLoadResult(result);
    expect(data.sheets[0]!.styles?.['9:2']).toEqual({ bold: true, numberFormatCode: '0.00%' });
    expect(data.sheets[0]!.formats?.['9:2']).toBe('0.00%');

    // Hydration seeding → the render store Grid.tsx reads.
    const store = importedFormatsToStore(data);
    const fmt = getFormat(store, SHEET, 9, 2);
    expect(fmt?.bold).toBe(true);
    expect(fmt?.formatCode).toBe('0.00%');
    // Grid render outcomes: bold → font-weight 700; the format code
    // renders C10's true value 0 as "0.00%" (not plain "0").
    expect(formatToCSS(fmt).fontWeight).toBe('700');
    expect(formatWithCode(0, fmt!.formatCode!)).toBe('0.00%');
  });
});

describe('E2: openDesktopBuffer call order (the actual defect)', () => {
  it('notifies host-replaced BEFORE hydrating, so the reset cannot wipe the seeded formats', () => {
    const appSrc = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');
    const start = appSrc.indexOf('const openDesktopBuffer');
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf('const openXlsxBuffer', start);
    const body = appSrc.slice(start, end > start ? end : undefined);
    const notifyAt = body.indexOf('notifyHostReplaced()');
    const hydrateAt = body.indexOf('hydrateOpenedWorkbook(');
    expect(notifyAt).toBeGreaterThan(-1);
    expect(hydrateAt).toBeGreaterThan(-1);
    // The host-replaced handler runs setFormats(createFormatStore());
    // hydration runs setFormats(importedFormatsToStore(data)). Notify
    // must come first — the order the gateway/local opens already used.
    expect(notifyAt).toBeLessThan(hydrateAt);
    // And the hydration input is the desktop load-result reconstruction
    // that carries formats + styles across (pinned functionally above).
    expect(body).toContain('workbookDataFromDesktopLoadResult(res)');
  });
});
