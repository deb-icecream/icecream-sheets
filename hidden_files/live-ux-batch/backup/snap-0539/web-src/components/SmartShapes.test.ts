/**
 * Unit tests for the SmartArt SVG renderer (incl. the three families added
 * for XLSX diagram import: relationship, pyramid, matrix).
 */
import { describe, expect, it } from 'vitest';
import { smartArtSvg, SMARTART_LAYOUTS } from './SmartShapes';

describe('smartArtSvg', () => {
  it('exposes all seven families in the layout gallery', () => {
    expect(SMARTART_LAYOUTS.map((l) => l.id).sort()).toEqual(
      ['cycle', 'hierarchy', 'list', 'matrix', 'process', 'pyramid', 'relationship'].sort(),
    );
  });

  it('renders the pre-existing four layouts unchanged in shape', () => {
    for (const layout of ['list', 'process', 'cycle', 'hierarchy'] as const) {
      const { svg, width, height } = smartArtSvg(layout, ['A', 'B', 'C']);
      expect(svg).toContain('<svg');
      expect(svg).toContain('A');
      expect(svg).toContain('B');
      expect(svg).toContain('C');
      expect(width).toBe(560);
      expect(height).toBe(360);
    }
  });

  it('renders the relationship layout with a hub and satellites', () => {
    const { svg } = smartArtSvg('relationship', ['Hub', 'S1', 'S2', 'S3']);
    expect(svg).toContain('Hub');
    expect(svg).toContain('S1');
    // hub circle (r=52) + 3 satellite circles (r=40)
    expect((svg.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('renders the pyramid layout as stacked layers', () => {
    const { svg } = smartArtSvg('pyramid', ['Top', 'Mid', 'Base']);
    expect(svg).toContain('Top');
    expect(svg).toContain('Base');
    expect((svg.match(/<polygon/g) ?? []).length).toBe(3);
  });

  it('renders the matrix layout as a four-quadrant grid', () => {
    const { svg } = smartArtSvg('matrix', ['Q1', 'Q2', 'Q3', 'Q4']);
    expect(svg).toContain('Q1');
    expect(svg).toContain('Q4');
    expect((svg.match(/<rect/g) ?? []).length).toBe(4);
  });

  it('escapes XML in labels', () => {
    const { svg } = smartArtSvg('list', ['<b>&']);
    expect(svg).toContain('&lt;b&gt;&amp;');
  });

  it('appends a visible wrapped caption strip when a note is given', () => {
    const short = smartArtSvg('process', ['A', 'B'], { note: 'closest match note' });
    expect(short.svg).toContain('closest match note');
    expect(short.height).toBe(360 + 32); // one wrapped line
    const longNote =
      'SmartArt layout "Mystic Funnel Widget" (mysticFunnelWidget) has no exact layout renderer; rendered as Process (closest match).';
    const long = smartArtSvg('process', ['A', 'B'], { note: longNote });
    expect(long.svg).toContain('Mystic Funnel Widget');
    expect(long.svg).toContain('(closest match).');
    expect(long.height).toBe(360 + 48); // two wrapped lines
  });

  it('fits hierarchy child boxes to their slots and wraps long labels', () => {
    // 5 children → slot 104px < the old fixed 150px box: boxes must not overlap.
    const items = ['President [Name]', 'VP - Sales [Name]', 'VP - Production [Name]', 'VP - Marketing [Name]', 'CFO [Name]', 'COO [Name]'];
    const { svg } = smartArtSvg('hierarchy', items);
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)" height="52"/g)].map(
      (m) => ({ x: parseFloat(m[1]), w: parseFloat(m[2]) }),
    );
    // parent box (180 wide) + 5 child boxes
    const kids = rects.filter((r) => r.w < 150).sort((a, b) => a.x - b.x);
    expect(kids.length).toBe(5);
    for (let i = 1; i < kids.length; i += 1) {
      expect(kids[i].x).toBeGreaterThanOrEqual(kids[i - 1].x + kids[i - 1].w);
    }
    // Long labels wrap or truncate instead of bleeding into neighbours.
    expect(svg).toContain('VP - Sales');
    expect(svg).not.toContain('VP - Sales [Name]');
  });

  it('emits well-formed SVG: no tag carries a duplicate attribute', () => {
    const note = 'SmartArt layout "X" (xid) has no exact layout renderer; rendered as Process (closest match).';
    for (const l of SMARTART_LAYOUTS) {
      for (const opts of [undefined, { note }]) {
        const { svg } = smartArtSvg(l.id, ['Alpha', 'Beta', 'Gamma', 'Delta'], opts);
        for (const tag of svg.match(/<[^!?/][^>]*>/g) ?? []) {
          const names = [...tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)=/g)].map((m) => m[1]);
          const dupes = names.filter((n, i) => names.indexOf(n) !== i);
          expect(dupes, `${l.id} tag ${tag.slice(0, 60)}`).toEqual([]);
        }
        expect(svg).toContain('Alpha');
      }
    }
  });
});
