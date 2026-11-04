// @vitest-environment jsdom
/**
 * ColumnStatsDialog render tests (Data > Column Statistics).
 * Renders the service-layer profile and checks the key statistics appear.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { profileColumn } from '@icecream-sheets/service';
import ColumnStatsDialog from './ColumnStatsDialog';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

const profiles = [
  profileColumn({ name: 'Amount', values: [10, 20, 20, 30, null, 'n/a'] }),
];

describe('ColumnStatsDialog', () => {
  it('renders counts, aggregates and most-common values', () => {
    const el = setup(h(ColumnStatsDialog, { title: 'Column A', profiles, onClose: () => {} }));
    const text = el.textContent ?? '';
    expect(text).toContain('Amount');
    expect(text).toContain('Unique');
    expect(text).toContain('Mean');
    expect(text).toContain('20'); // min/max/mean/median all 20 here
    expect(text).toContain('Most common');
    expect(text).toContain('×2');
  });

  it('shows an empty state with no profiles', () => {
    const el = setup(h(ColumnStatsDialog, { title: 'Column A', profiles: [], onClose: () => {} }));
    expect(el.textContent ?? '').toContain('No values to profile.');
  });

  it('calls onClose from the Close button', () => {
    const onClose = vi.fn();
    const el = setup(h(ColumnStatsDialog, { title: 'Column A', profiles, onClose }));
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    expect(btn).toBeDefined();
    act(() => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
