// @vitest-environment jsdom
/**
 * PageBreakLines render tests: manual page breaks render as dashed blue
 * lines at the correct pixel positions; out-of-range breaks are skipped.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import PageBreakLines from './PageBreakLines';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container!;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

const geom = {
  colX: (c: number) => 44 + c * 96,
  rowY: (r: number) => 24 + r * 24,
  width: 2000,
  height: 3000,
  maxRow: 100,
  maxCol: 26,
};

describe('PageBreakLines', () => {
  it('renders a row break line below the break row', () => {
    const el = setup(h(PageBreakLines, { breaks: { rows: [9], cols: [] }, ...geom }));
    const lines = el.querySelectorAll('div');
    expect(lines).toHaveLength(1);
    const style = (lines[0] as HTMLElement).style;
    // Break after row 9 → line at top edge of row 10: 24 + 10*24 - 1.
    expect(style.top).toBe('263px');
    expect(style.borderTop).toContain('dashed');
  });

  it('renders a column break line right of the break column', () => {
    const el = setup(h(PageBreakLines, { breaks: { rows: [], cols: [4] }, ...geom }));
    const lines = el.querySelectorAll('div');
    expect(lines).toHaveLength(1);
    const style = (lines[0] as HTMLElement).style;
    // Break after col 4 → line at left edge of col 5: 44 + 5*96 - 1.
    expect(style.left).toBe('523px');
    expect(style.borderLeft).toContain('dashed');
  });

  it('renders multiple breaks and skips out-of-range ones', () => {
    const el = setup(
      h(PageBreakLines, { breaks: { rows: [9, 500], cols: [4, -2] }, ...geom }),
    );
    // rows: 9 ok, 500 >= maxRow skipped; cols: 4 ok, -2 skipped.
    expect(el.querySelectorAll('div')).toHaveLength(2);
  });

  it('renders nothing when there are no breaks', () => {
    const el = setup(h(PageBreakLines, { breaks: { rows: [], cols: [] }, ...geom }));
    expect(el.querySelectorAll('div')).toHaveLength(0);
  });

  it('lines are non-interactive overlays', () => {
    const el = setup(h(PageBreakLines, { breaks: { rows: [1], cols: [] }, ...geom }));
    const style = (el.querySelector('div') as HTMLElement).style;
    expect(style.pointerEvents).toBe('none');
    expect(style.position).toBe('absolute');
  });
});
