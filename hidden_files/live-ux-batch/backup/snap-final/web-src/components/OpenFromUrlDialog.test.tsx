// @vitest-environment jsdom
/**
 * Open from URL dialog tests: URL validation and read-only hint.
 * (Full UI screenshot verification is blocked by a pre-existing
 * HyperFormula/Vite bundling issue — the app fails to load in both dev and
 * production builds, unrelated to these changes.)
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';
import OpenFromUrlDialog from './OpenFromUrlDialog';

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function setup(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (container) container.remove();
  container = null;
  root = null;
});

function clickOpen() {
  const btn = Array.from(container!.querySelectorAll('button')).find(
    (b) => b.textContent === 'Open',
  )!;
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setUrl(value: string) {
  const input = container!.querySelector('input[type="url"]') as HTMLInputElement;
  act(() => {
    Simulate.change(input, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
  });
}

describe('OpenFromUrlDialog', () => {
  it('rejects empty URL', () => {
    let opened: string | null = null;
    setup(h(OpenFromUrlDialog, { onClose: () => {}, onOpen: (u: string) => { opened = u; } }));
    clickOpen();
    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Enter a URL/);
    expect(opened).toBeNull();
  });

  it('rejects invalid URL', () => {
    let opened: string | null = null;
    setup(h(OpenFromUrlDialog, { onClose: () => {}, onOpen: (u: string) => { opened = u; } }));
    setUrl('not a url');
    clickOpen();
    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/valid URL/);
    expect(opened).toBeNull();
  });

  it('rejects non-http(s) URLs', () => {
    let opened: string | null = null;
    setup(h(OpenFromUrlDialog, { onClose: () => {}, onOpen: (u: string) => { opened = u; } }));
    setUrl('ftp://example.com/f.xlsx');
    clickOpen();
    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/http/);
    expect(opened).toBeNull();
  });

  it('accepts https URL and calls onOpen', () => {
    let opened: string | null = null;
    setup(h(OpenFromUrlDialog, { onClose: () => {}, onOpen: (u: string) => { opened = u; } }));
    setUrl('https://example.com/workbook.xlsx');
    clickOpen();
    expect(opened).toBe('https://example.com/workbook.xlsx');
  });

  it('mentions read-only in the hint', () => {
    setup(h(OpenFromUrlDialog, { onClose: () => {}, onOpen: () => {} }));
    expect(container!.textContent).toMatch(/read-only/i);
  });
});
