// @vitest-environment jsdom
/**
 * Issue #43 — the formula bar must show a formula cell's FORMULA, not
 * its computed value. The defect was state-dependent: cells whose
 * formula the host's sync view already knew (e.g. a locked cell that
 * had taken a single-cell read path) displayed correctly, while
 * ordinary formula cells filled by values-only bulk/stream fills
 * showed the value (desktop run 2: A3 =SUM showed "35"). These tests
 * pin the bar's contract against a host whose sync view mirrors the
 * defective state:
 *   A. sync view KNOWS the formula -> shown immediately, no async read.
 *   B. sync view has value only    -> the bar resolves the formula via
 *      the host's authoritative readCellAsync and swaps it in.
 *   C. plain value cell            -> stays the value.
 *   D. the async swap NEVER clobbers text the user already typed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { EngineHost, type TypedCell, type TypedValue, type TypedView } from '@icecream-sheets/engine';
import FormulaBar from './FormulaBar';

const NUM = (n: number): TypedValue => ({ kind: 'number', value: n });

class StubHost extends EngineHost {
  readonly readCellAsync: ReturnType<typeof vi.fn>;
  constructor(
    private readonly syncCell: TypedCell,
    asyncImpl: () => Promise<{ value: TypedValue; formula?: string }>,
  ) {
    super();
    this.readCellAsync = vi.fn(asyncImpl);
  }
  override getView(): TypedView {
    const cell = this.syncCell;
    return {
      readCell: () => cell,
      readRange: () => [],
      usedRange: () => null,
    } as unknown as TypedView;
  }
}

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

function renderBar(host: EngineHost, row: number, col: number): HTMLInputElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<FormulaBar host={host} sheet="Sheet1" sel={{ row, col }} onCommit={() => {}} />);
  });
  return container.querySelector('.formula-input') as HTMLInputElement;
}

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

describe('FormulaBar — issue #43 formula display', () => {
  it('A: shows the formula immediately when the sync view knows it (locked-cell state)', async () => {
    const host = new StubHost(
      { ref: { sheet: 'Sheet1', row: 13, col: 2 }, value: NUM(42), formula: 'C12*C13' },
      async () => ({ value: NUM(42), formula: 'C12*C13' }),
    );
    const input = renderBar(host, 13, 2);
    expect(input.value).toBe('=C12*C13');
    await flush();
    expect(input.value).toBe('=C12*C13');
    expect(host.readCellAsync).not.toHaveBeenCalled();
  });

  it('B: resolves the formula via readCellAsync when the sync view has value only (run-2 state)', async () => {
    const host = new StubHost(
      { ref: { sheet: 'Sheet1', row: 2, col: 0 }, value: NUM(30) },
      async () => ({ value: NUM(30), formula: 'SUM(A1:A2)' }),
    );
    const input = renderBar(host, 2, 0);
    expect(input.value).toBe('30'); // defective seed, before resolution lands
    await flush();
    expect(input.value).toBe('=SUM(A1:A2)');
    expect(host.readCellAsync).toHaveBeenCalledTimes(1);
  });

  it('C: a plain value cell stays the value after resolution', async () => {
    const host = new StubHost(
      { ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: NUM(10) },
      async () => ({ value: NUM(10) }),
    );
    const input = renderBar(host, 0, 0);
    await flush();
    expect(input.value).toBe('10');
    expect(host.readCellAsync).toHaveBeenCalledTimes(1);
  });

  it('D: never clobbers text the user typed while resolution was in flight', async () => {
    let resolveIt: ((v: { value: TypedValue; formula?: string }) => void) | null = null;
    const host = new StubHost(
      { ref: { sheet: 'Sheet1', row: 2, col: 0 }, value: NUM(30) },
      () =>
        new Promise((res) => {
          resolveIt = res;
        }),
    );
    const input = renderBar(host, 2, 0);
    expect(input.value).toBe('30');
    // User starts editing the bar before the async read lands.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '99');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe('99');
    await act(async () => {
      resolveIt!({ value: NUM(30), formula: 'SUM(A1:A2)' });
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(input.value).toBe('99'); // user text wins
  });
});
