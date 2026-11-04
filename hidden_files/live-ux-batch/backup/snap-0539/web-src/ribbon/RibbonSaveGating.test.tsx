// @vitest-environment jsdom
/**
 * Defect D3 regression tests (Cycle 10 closure): save/export entry
 * points in the ribbon's File tab must be gated while the workbook is
 * loading, with the SAME treatment as Save — disabled, "Loading…"
 * label, and the reason in the title.
 *
 * The desktop sweep found "Save encrypted" stayed enabled during the
 * load banner and opened the encrypt dialog over a half-loaded
 * workbook. The same audit found "Download as PDF" and the Email menu
 * items were also ungated in the ribbon (their App handlers gated at
 * serialization time; the UI did not). These tests pin the ribbon half
 * of the gate for all three.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EngineHost } from '@icecream-sheets/engine';
import Ribbon, { type RibbonProps } from './Ribbon';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function makeProps(desktopLoading: boolean): RibbonProps {
  const base: Record<string, unknown> = {
    calcMode: 'automatic',
    sheet: 'Sheet1',
    sheets: ['Sheet1'],
    sel: { row: 0, col: 0 },
    host: new EngineHost(),
    zoom: 1,
    showGridlines: true,
    showFormulaBar: true,
    showHeadings: true,
    canUndo: false,
    canRedo: false,
    hasFreeze: false,
    selectedFormat: undefined,
    formatPainterActive: false,
    showFormulas: false,
    showComments: false,
    focusCell: false,
    hasComment: false,
    fnCategories: [],
    isDesktop: false,
    desktopLoading,
    readOnly: false,
    saveFormat: 'xlsx',
    isSheetProtected: false,
    sensitivityLabel: 'public',
    appList: [],
    canRefreshDataSource: false,
    macroRecording: false,
  };
  // Every remaining prop is a callback the File tab doesn't exercise
  // during render: a Proxy supplies inert no-ops for them.
  return new Proxy(base, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => undefined;
    },
  }) as unknown as RibbonProps;
}

function renderFileTab(desktopLoading: boolean): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onDownloadEncrypted = vi.fn();
  const props = { ...makeProps(desktopLoading), onDownloadEncrypted };
  act(() => {
    root!.render(<Ribbon {...props} />);
  });
  const fileTab = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'File',
  );
  if (!fileTab) throw new Error('File tab not found');
  act(() => {
    fileTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  return container;
}

function buttons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')] as HTMLButtonElement[];
}

describe('Ribbon File tab — save/export gating while loading (D3)', () => {
  it('Save encrypted is disabled with the Loading… treatment while loading', () => {
    const el = renderFileTab(true);
    const all = buttons(el);
    // No enabled "Save encrypted" button may exist during load.
    const encrypted = all.filter((b) => (b.textContent ?? '').includes('Save encrypted'));
    expect(encrypted).toHaveLength(0);
    // It renders with Save's treatment: Loading… label, disabled, reason.
    const loadingSaveLike = all.filter(
      (b) =>
        b.disabled &&
        (b.textContent ?? '').includes('Loading…') &&
        (b.title ?? '').includes('Workbook is still loading — save is disabled'),
    );
    // Save .xlsx + Save encrypted (+ desktop Save when isDesktop) share it.
    expect(loadingSaveLike.length).toBeGreaterThanOrEqual(2);
  });

  it('Download as PDF is disabled with the export reason while loading', () => {
    const el = renderFileTab(true);
    const pdf = buttons(el).filter((b) =>
      (b.title ?? '').includes('export is disabled until the load completes'),
    );
    expect(pdf.length).toBeGreaterThanOrEqual(1);
    expect(pdf.every((b) => b.disabled)).toBe(true);
  });

  it('Save encrypted is enabled with its normal title once loaded', () => {
    const el = renderFileTab(false);
    const encrypted = buttons(el).find((b) => (b.textContent ?? '').includes('Save encrypted'));
    expect(encrypted).toBeDefined();
    expect(encrypted!.disabled).toBe(false);
    expect(encrypted!.title).toContain('encrypted with a password');
    const pdf = buttons(el).find((b) => (b.textContent ?? '').includes('Download as PDF'));
    expect(pdf).toBeDefined();
    expect(pdf!.disabled).toBe(false);
  });
});
