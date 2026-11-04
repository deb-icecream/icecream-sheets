// @vitest-environment jsdom
/**
 * LandingPage tests (2026-10-22 narrative rebuild, design-docs/
 * homepage-narrative.md): the page presents an AI-native data workspace
 * and is organized by the data pipeline — agent headline first, then
 * Connect, Process, Visualize, Share — with Excel parity LAST as one
 * brief credibility strip (517/523 functions, published benchmark
 * 463/465 = 99.57%). Plus the standing invariants: the single
 * "Sign in with Google" sign-in action, Default vs Pro with EXACT tier
 * labels, and no tier named "free" anywhere.
 * Uses the repo's raw react-dom/test-utils pattern (no testing-library).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { LandingPage } from './LandingPage';

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
});

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonsWith(el: HTMLElement, text: string): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text);
}

describe('LandingPage', () => {
  it('leads with the AI-native data workspace, agent first — not the spreadsheet', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const text = el.textContent ?? '';
    expect(text).toContain('An AI-native data workspace');
    expect(text).toContain('An AI that works on your data');
    expect(text).toContain('Ask. It answers.');
    expect(text).toContain('same tools you use');
    expect(text).toContain('A spreadsheet here is a view');
    expect(text).toContain('One sheet. Everyone in it. Live.');
    expect(text).toContain('Icecream Sheets');
  });

  it('orders the page by the data pipeline, parity last as a credibility strip', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const labelled = [...el.querySelectorAll('section[aria-labelledby]')].map((s) =>
      s.getAttribute('aria-labelledby'),
    );
    expect(labelled).toEqual([
      'ics-lp-agent',
      'ics-lp-connect',
      'ics-lp-process',
      'ics-lp-visualize',
      'ics-lp-share',
      'ics-lp-proof',
      'ics-lp-plans',
    ]);
    const text = el.textContent ?? '';
    expect(text).toContain('517');
    expect(text).toContain('523 functions');
    expect(text).toContain('99.57%');
    expect(text).toContain('463 of 465');
    expect(text).toContain('round-trip');
    // The credibility strip comes after Share in reading order too.
    expect(text.indexOf('One sheet. Everyone in it. Live.')).toBeLessThan(text.indexOf('517'));
  });

  it('shows the real agent exchange from the validation record', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const text = el.textContent ?? '';
    expect(text).toContain('total revenue in the Sales sheet');
    expect(text).toContain('$159,400');
  });

  it('uses the real product images for every pipeline beat, each with real alt text', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const imgs = [...el.querySelectorAll('img')];
    const srcs = imgs.map((img) => img.getAttribute('src'));
    expect(srcs).toContain('/product/agent-work.png');
    expect(srcs).toContain('/product/connect-source.png');
    expect(srcs).toContain('/product/pivotchart.png');
    expect(srcs).toContain('/product/hero-dashboard.png');
    expect(srcs).toContain('/product/collab.png');
    for (const img of imgs) {
      expect((img.getAttribute('alt') ?? '').length).toBeGreaterThan(20);
    }
  });

  it('names the data sources the grid can sit over', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const facts = [...el.querySelectorAll('.ics-lp-fact')].map((f) => f.textContent ?? '');
    expect(facts).toHaveLength(3);
    const text = el.textContent ?? '';
    expect(text).toContain('Excel files');
    expect(text).toContain('CSV');
    expect(text).toContain('REST and SQL');
  });

  it('tier headings are EXACTLY "Default" and "Pro", and the word "free" appears nowhere', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const headings = [...el.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((n) =>
      n.textContent?.trim(),
    );
    expect(headings).toContain('Default');
    expect(headings).toContain('Pro');
    const tiersSection = [...el.querySelectorAll('section')].find((s) =>
      [...s.querySelectorAll('h3')].some((n) => n.textContent?.trim() === 'Default'),
    );
    expect(tiersSection).toBeTruthy();
    expect(tiersSection!.textContent).toContain('~1.3 MB');
    expect(tiersSection!.textContent).toContain('10 files');
    expect(tiersSection!.textContent).toContain('any size');
    expect(/free/i.test(tiersSection!.textContent ?? '')).toBe(false);
    expect(/free/i.test(el.textContent ?? '')).toBe(false);
  });

  it('logged-out: the only sign-in action is "Sign in with Google", firing onSignIn', () => {
    const onSignIn = vi.fn();
    const onOpenWorkspace = vi.fn();
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn, onOpenWorkspace }));
    const googleButtons = buttonsWith(el, 'Sign in with Google');
    expect(googleButtons.length).toBeGreaterThan(0);
    expect(buttonsWith(el, 'Sign in')).toHaveLength(0);
    expect(buttonsWith(el, 'Open workspace')).toHaveLength(0);
    click(googleButtons[0]!);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).not.toHaveBeenCalled();
  });

  it('logged-in: Open workspace buttons fire onOpenWorkspace, never onSignIn', () => {
    const onSignIn = vi.fn();
    const onOpenWorkspace = vi.fn();
    const el = setup(h(LandingPage, { loggedIn: true, onSignIn, onOpenWorkspace }));
    const openButtons = buttonsWith(el, 'Open workspace');
    expect(openButtons.length).toBeGreaterThan(0);
    expect(buttonsWith(el, 'Sign in with Google')).toHaveLength(0);
    click(openButtons[0]!);
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('renders every section visibly even without IntersectionObserver (jsdom)', () => {
    const el = setup(h(LandingPage, { loggedIn: false, onSignIn: vi.fn(), onOpenWorkspace: vi.fn() }));
    const reveals = [...el.querySelectorAll('.ics-lp-reveal')];
    expect(reveals.length).toBeGreaterThan(5);
    for (const r of reveals) {
      expect(r.classList.contains('ics-lp-in')).toBe(true);
    }
  });
});
