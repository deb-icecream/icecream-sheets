/**
 * Unit tests for Paste as Picture / Paste as Linked Picture helpers.
 */
import { describe, expect, it } from 'vitest';
import { renderRangeAsSvg, svgToDataUrl } from './pastePicture';

describe('renderRangeAsSvg', () => {
  it('renders cells with grid lines', () => {
    const { svg, width, height } = renderRangeAsSvg([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('>a<');
    expect(svg).toContain('>d<');
    expect(width).toBe(161); // 2 * 80 + 1
    expect(height).toBe(45); // 2 * 22 + 1
  });

  it('escapes XML in cell text', () => {
    const { svg } = renderRangeAsSvg([['<b>&']]);
    expect(svg).toContain('&lt;b&gt;&amp;');
  });

  it('clips long text with an ellipsis', () => {
    const { svg } = renderRangeAsSvg([['x'.repeat(100)]], { colWidths: [40], fontSize: 12 });
    expect(svg).toContain('…');
  });

  it('honors custom column widths and row height', () => {
    const { width, height } = renderRangeAsSvg([['a']], { colWidths: [120], rowHeight: 30 });
    expect(width).toBe(121);
    expect(height).toBe(31);
  });

  it('handles ragged rows', () => {
    const { svg } = renderRangeAsSvg([['a', 'b', 'c'], ['d']]);
    expect(svg).toContain('>c<');
    expect(svg).toContain('>d<');
  });
});

describe('svgToDataUrl', () => {
  it('produces a data URL', () => {
    const url = svgToDataUrl('<svg></svg>');
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1])).toBe('<svg></svg>');
  });
});
