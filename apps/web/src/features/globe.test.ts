import { describe, expect, it } from 'vitest';
import { project, projectPoints, pointsFromRows, graticule } from './globe';

describe('globe projection', () => {
  it('projects the center point to the middle and visible', () => {
    const p = project(0, 0, 0, 0);
    expect(Math.abs(p.x)).toBeLessThan(1e-9);
    expect(Math.abs(p.y)).toBeLessThan(1e-9);
    expect(p.visible).toBe(true);
  });
  it('marks the antipode as hidden', () => {
    const p = project(0, 180, 0, 0);
    expect(p.visible).toBe(false);
  });
  it('keeps points within the unit disc', () => {
    for (const [lat, lon] of [[40, -74], [-33, 151], [51, 0], [35, 139]] as const) {
      const p = project(lat, lon, 0, 0);
      expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('rotation moves the center', () => {
    const p = project(40.7, -74, -74, 40.7);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(0.01);
    expect(p.visible).toBe(true);
  });
  it('projectPoints carries labels and values', () => {
    const [p] = projectPoints([{ lat: 10, long: 20, label: 'X', value: 5 }], 0, 0);
    expect(p.label).toBe('X');
    expect(p.value).toBe(5);
  });
});

describe('pointsFromRows', () => {
  it('extracts valid lat/long rows and skips bad ones', () => {
    const pts = pointsFromRows(
      ['City', 'Lat', 'Lon', 'Pop'],
      [['A', '40.7', '-74.0', '8M'], ['B', 'bad', '10', 'x'], ['C', '95', '10', 'y']],
      1, 2, 0, 3,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0].label).toBe('A');
    expect(pts[0].value).toBeUndefined(); // '8M' is not numeric
  });
});

describe('graticule', () => {
  it('generates segments', () => {
    const g = graticule(0, 0, 90);
    expect(g.length).toBeGreaterThan(0);
    expect(g.every((s) => Math.abs(s.x1) <= 1 && Math.abs(s.y1) <= 1)).toBe(true);
  });
});
