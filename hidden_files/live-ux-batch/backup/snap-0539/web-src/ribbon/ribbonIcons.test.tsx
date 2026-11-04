/**
 * Tests for the ribbon SVG icon library (icons.tsx) and the `icon` prop
 * support on RibbonButton / RibbonMenu.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconCut, ribbonIcons } from './icons';
import { RibbonButton, RibbonMenu } from './RibbonControls';

const entries = Object.entries(ribbonIcons) as Array<[string, (typeof ribbonIcons)[keyof typeof ribbonIcons]]>;

describe('ribbon icon library', () => {
  it('exports a comprehensive, non-empty icon set', () => {
    expect(entries.length).toBeGreaterThan(150);
  });

  it('exports unique components (no accidental duplicates)', () => {
    const seen = new Set<unknown>();
    for (const [, C] of entries) {
      // IconLink is an intentional alias of IconHyperlink.
      if (C === ribbonIcons.hyperlink) continue;
      expect(seen.has(C)).toBe(false);
      seen.add(C);
    }
  });

  it.each(entries.map(([name]) => name))('icon "%s" renders a valid, non-empty SVG', (name) => {
    const C = ribbonIcons[name as keyof typeof ribbonIcons];
    const html = renderToStaticMarkup(createElement(C));
    // Root element is an <svg> with the 24x24 viewBox.
    expect(html.startsWith('<svg')).toBe(true);
    expect(html).toContain('viewBox="0 0 24 24"');
    // At least one graphical child element.
    expect(/<(path|circle|rect|ellipse|line|polyline|polygon|text|g)\b/.test(html)).toBe(true);
    // No empty path data anywhere (the "no empty paths" rule).
    for (const m of html.matchAll(/<path\b[^>]*>/g)) {
      const d = /d="([^"]*)"/.exec(m[0]);
      expect(d, `empty <path> in icon "${name}"`).toBeTruthy();
      expect(d![1].trim().length, `empty d attribute in icon "${name}"`).toBeGreaterThan(0);
    }
  });

  it('icons accept size and title props', () => {
    const html = renderToStaticMarkup(createElement(IconCut, { size: 32, title: 'Cut' }));
    expect(html).toContain('width="32"');
    expect(html).toContain('<title>Cut</title>');
    expect(html).not.toContain('aria-hidden');
  });

  it('icons are decorative (aria-hidden) by default', () => {
    const html = renderToStaticMarkup(createElement(IconCut));
    expect(html).toContain('aria-hidden="true"');
  });
});

describe('RibbonButton icon support', () => {
  it('renders the icon when provided', () => {
    const html = renderToStaticMarkup(<RibbonButton label="Cut" icon={<IconCut />} />);
    expect(html).toContain('<svg');
    expect(html).toContain('ribbon-btn-icon');
    expect(html).toContain('with-icon');
    expect(html).toContain('Cut');
  });

  it('renders no icon markup when omitted (backward compatible)', () => {
    const html = renderToStaticMarkup(<RibbonButton label="Cut" />);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('ribbon-btn-icon');
    expect(html).not.toContain('with-icon');
    expect(html).toContain('Cut');
  });

  it('keeps size/active/disabled behavior with an icon', () => {
    const html = renderToStaticMarkup(
      <RibbonButton label="Bold" size="large" active disabled icon={<IconCut />} />,
    );
    expect(html).toContain('ribbon-btn large active disabled with-icon');
    expect(html).toContain('<svg');
  });
});

describe('RibbonMenu icon support', () => {
  it('renders the icon when provided', () => {
    const html = renderToStaticMarkup(
      <RibbonMenu label="Paste" icon={<IconCut />}>
        <span>item</span>
      </RibbonMenu>,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('ribbon-btn-icon');
    expect(html).toContain('with-icon');
    expect(html).toContain('Paste');
  });

  it('renders no icon markup when omitted (backward compatible)', () => {
    const html = renderToStaticMarkup(
      <RibbonMenu label="Paste">
        <span>item</span>
      </RibbonMenu>,
    );
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('with-icon');
  });
});
