/**
 * Filled Map (choropleth) tests: country resolution, color scaling,
 * projection, and end-to-end SVG rendering of a 5-country dataset.
 */
import { describe, expect, it } from 'vitest';
import {
  MAP_HIGH_COLOR,
  MAP_LOW_COLOR,
  MAP_NO_DATA_COLOR,
  buildChartConfig,
  buildMapSvg,
  countryPathData,
  isSvgKind,
  makeChartSpec,
  mapColorScale,
  mapSeriesToCountries,
  projectLonLat,
  resolveCountry,
  WORLD_COUNTRIES,
  type ChartSeries,
} from '../src/index.js';

const FIVE: ChartSeries = {
  labels: ['United States', 'China', 'Germany', 'Brazil', 'India'],
  datasets: [{ label: 'Sales', data: [100, 80, 60, 40, 20] }],
};

describe('country resolution', () => {
  it('resolves display names, aliases and ISO codes', () => {
    expect(resolveCountry('Germany')?.a2).toBe('DE');
    expect(resolveCountry('germany')?.a2).toBe('DE');
    expect(resolveCountry('USA')?.a2).toBe('US');
    expect(resolveCountry('US')?.a2).toBe('US');
    expect(resolveCountry('USA')?.a3).toBe('USA');
    expect(resolveCountry('840')?.a2).toBe('US');
    expect(resolveCountry('UK')?.a2).toBe('GB');
    expect(resolveCountry('Russia')?.a2).toBe('RU');
    expect(resolveCountry('South Korea')?.a2).toBe('KR');
    expect(resolveCountry('Dem. Rep. Congo')?.a2).toBe('CD');
    expect(resolveCountry('DRC')?.a2).toBe('CD');
    expect(resolveCountry('Congo')?.a2).toBe('CG');
  });

  it('returns null for unknown labels', () => {
    expect(resolveCountry('Atlantis')).toBeNull();
    expect(resolveCountry('')).toBeNull();
    expect(resolveCountry('   ')).toBeNull();
  });

  it('bundles a sane world dataset', () => {
    expect(WORLD_COUNTRIES.length).toBeGreaterThan(150);
    for (const c of WORLD_COUNTRIES) {
      expect(c.p.length).toBeGreaterThan(0);
      for (const ring of c.p) {
        expect(ring.length % 2).toBe(0);
        expect(ring.length).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

describe('color scaling', () => {
  it('maps min->low color and max->high color', () => {
    const scale = mapColorScale(20, 100);
    expect(scale(20)).toBe(MAP_LOW_COLOR);
    expect(scale(100)).toBe(MAP_HIGH_COLOR);
  });

  it('interpolates and clamps', () => {
    const scale = mapColorScale(0, 100);
    const mid = scale(50);
    expect(mid).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(mid).not.toBe(MAP_LOW_COLOR);
    expect(mid).not.toBe(MAP_HIGH_COLOR);
    expect(scale(-10)).toBe(MAP_LOW_COLOR);
    expect(scale(999)).toBe(MAP_HIGH_COLOR);
  });

  it('handles degenerate ranges', () => {
    const scale = mapColorScale(50, 50);
    expect(scale(50)).toBe(MAP_HIGH_COLOR);
  });
});

describe('projection', () => {
  it('maps lon/lat to the SVG viewport', () => {
    const [x0, y0] = projectLonLat(-180, 90, 720, 360);
    expect(x0).toBe(0);
    expect(y0).toBe(0);
    const [x1, y1] = projectLonLat(180, -90, 720, 360);
    expect(x1).toBe(720);
    expect(y1).toBe(360);
    const [xc, yc] = projectLonLat(0, 0, 720, 360);
    expect(xc).toBe(360);
    expect(yc).toBe(180);
  });

  it('produces non-empty path data for a country', () => {
    const usa = resolveCountry('United States');
    expect(usa).not.toBeNull();
    const d = countryPathData(usa!, 720, 360);
    expect(d).toContain('M');
    expect(d).toContain('Z');
    expect(d.length).toBeGreaterThan(100);
  });
});

describe('series mapping', () => {
  it('maps the 5-country dataset with correct colors', () => {
    const data = mapSeriesToCountries(FIVE);
    expect(data.unmatched).toEqual([]);
    expect(data.regions).toHaveLength(5);
    expect(data.min).toBe(20);
    expect(data.max).toBe(100);
    const byLabel = new Map(data.regions.map((r) => [r.label, r]));
    // Highest value -> high color, lowest -> low color.
    expect(byLabel.get('United States')?.fill).toBe(MAP_HIGH_COLOR);
    expect(byLabel.get('India')?.fill).toBe(MAP_LOW_COLOR);
    const germany = byLabel.get('Germany')?.fill;
    expect(germany).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(germany).not.toBe(MAP_HIGH_COLOR);
    expect(germany).not.toBe(MAP_LOW_COLOR);
  });

  it('lists unmatched labels instead of dropping silently', () => {
    const data = mapSeriesToCountries({
      labels: ['France', 'Atlantis', 'Japan'],
      datasets: [{ label: 'V', data: [1, 2, 3] }],
    });
    expect(data.regions).toHaveLength(2);
    expect(data.unmatched).toEqual(['Atlantis']);
  });

  it('marks null values with the no-data color', () => {
    const data = mapSeriesToCountries({
      labels: ['France', 'Japan'],
      datasets: [{ label: 'V', data: [10, null] }],
    });
    const japan = data.regions.find((r) => r.label === 'Japan');
    expect(japan?.value).toBeNull();
    expect(japan?.fill).toBe(MAP_NO_DATA_COLOR);
  });

  it('dedupes repeated countries (first wins)', () => {
    const data = mapSeriesToCountries({
      labels: ['France', 'FR'],
      datasets: [{ label: 'V', data: [10, 20] }],
    });
    expect(data.regions).toHaveLength(1);
    expect(data.regions[0].value).toBe(10);
  });
});

describe('SVG rendering', () => {
  it('renders all bundled countries with data fills and legend', () => {
    const data = mapSeriesToCountries(FIVE);
    const svg = buildMapSvg(data, { width: 720, height: 360, title: 'Sales by country' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Sales by country');
    // One path per bundled country.
    const paths = svg.match(/<path /g) ?? [];
    expect(paths.length).toBe(WORLD_COUNTRIES.length);
    // The 5 data countries carry their scaled fills with tooltips.
    expect(svg).toContain(MAP_HIGH_COLOR); // USA = 100
    expect(svg).toContain('United States: 100');
    expect(svg).toContain('India: 20');
    // Non-data countries get the neutral fill.
    expect(svg).toContain(`fill="${MAP_NO_DATA_COLOR}"`);
    // Gradient legend with min/max labels.
    expect(svg).toContain('icecream-map-scale');
    expect(svg).toContain('>20<');
    expect(svg).toContain('>100<');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('escapes XML in titles and labels', () => {
    const data = mapSeriesToCountries(FIVE);
    const svg = buildMapSvg(data, { width: 200, height: 100, title: 'A&B <test>' });
    expect(svg).toContain('A&amp;B &lt;test&gt;');
    expect(svg).not.toContain('A&B <test>');
  });
});

describe('chart-model wiring', () => {
  it('map-filled is an SVG kind that builds', () => {
    expect(isSvgKind('map-filled')).toBe(true);
    const spec = makeChartSpec({
      kind: 'map-filled',
      range: { sheet: 'S', startRow: 0, startCol: 0, endRow: 5, endCol: 1 },
      title: 'Map',
    });
    const built = buildChartConfig(spec, FIVE);
    expect(built.svg).toBe('map');
    expect(built.renderedAs).toBeUndefined();
  });
});
