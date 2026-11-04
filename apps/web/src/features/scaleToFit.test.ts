import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCALE_TO_FIT,
  applyScaleToFit,
  effectivePrintScale,
  scaleToFitFromMetadata,
  scaleToFitToMetadata,
  type FitGeometry,
} from './scaleToFit';
import { DEFAULT_PAGE_SETUP } from '../components/PrintLayout';

const geom: FitGeometry = { totalCols: 20, totalRows: 100, colsPerPageAt100: 7, rowsPerPageAt100: 40 };

describe('effectivePrintScale', () => {
  it('returns 100 with no fit and no override', () => {
    expect(effectivePrintScale(DEFAULT_SCALE_TO_FIT, geom)).toBe(100);
  });

  it('explicit scale wins and is clamped', () => {
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, explicitScale: 55 }, geom)).toBe(55);
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, explicitScale: 5 }, geom)).toBe(10);
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, explicitScale: 900 }, geom)).toBe(400);
  });

  it('fit-wide computes scale so columns fit the page count', () => {
    // 20 cols, 7 per page at 100% -> 1 page wide needs 7/20*100 = 35%.
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, fitWide: 1 }, geom)).toBe(35);
    // 2 pages wide -> 70%.
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, fitWide: 2 }, geom)).toBe(70);
  });

  it('fit-tall computes scale so rows fit the page count', () => {
    // 100 rows, 40 per page -> 1 page tall needs 40%.
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, fitTall: 1 }, geom)).toBe(40);
  });

  it('takes the smaller candidate when both dimensions are set', () => {
    // wide wants 35%, tall wants 40% -> 35% fits both.
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, fitWide: 1, fitTall: 1 }, geom)).toBe(35);
  });

  it('ignores zero/negative fits', () => {
    expect(effectivePrintScale({ ...DEFAULT_SCALE_TO_FIT, fitWide: 0, fitTall: -1 }, geom)).toBe(100);
  });
});

describe('applyScaleToFit', () => {
  it('writes the effective scale into the page setup', () => {
    const setup = applyScaleToFit(DEFAULT_PAGE_SETUP, { ...DEFAULT_SCALE_TO_FIT, fitWide: 1 }, geom);
    expect(setup.scale).toBe(35);
    expect(setup.orientation).toBe(DEFAULT_PAGE_SETUP.orientation);
  });
});

describe('scaleToFit metadata', () => {
  it('round-trips', () => {
    const s = { fitWide: 1, fitTall: 2, explicitScale: null };
    expect(scaleToFitFromMetadata(scaleToFitToMetadata(s))).toEqual(s);
  });

  it('falls back to defaults on bad metadata', () => {
    expect(scaleToFitFromMetadata(null)).toEqual(DEFAULT_SCALE_TO_FIT);
    expect(scaleToFitFromMetadata({ fitWide: 'x', fitTall: 0, explicitScale: NaN })).toEqual(DEFAULT_SCALE_TO_FIT);
  });
});
