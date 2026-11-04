/**
 * Unit tests for imported-SmartArt → picture-overlay conversion.
 */
import { describe, expect, it } from 'vitest';
import type { ImportedSmartArt } from '@icecream-sheets/xlsx-adapter';
import {
  familyToLayout,
  importedSmartArtFromMetadata,
  importedSmartArtPictureName,
  importedSmartArtToPicture,
  smartArtLayoutMappingReport,
  smartArtPartsFromMetadata,
} from './importedSmartArt';

function diagram(over: Partial<ImportedSmartArt> = {}): ImportedSmartArt {
  return {
    sheetIndex: 0,
    sheetName: 'Sheet1',
    layoutId: 'basicProcess',
    layoutName: 'Basic Process',
    family: 'process',
    fallbackNote: null,
    items: ['One', 'Two'],
    anchor: { fromCol: 1, fromRow: 2, toCol: 6, toRow: 10 },
    ...over,
  };
}

describe('importedSmartArtFromMetadata', () => {
  it('parses valid metadata', () => {
    const out = importedSmartArtFromMetadata(JSON.stringify([diagram()]));
    expect(out.length).toBe(1);
    expect(out[0].items).toEqual(['One', 'Two']);
  });

  it('returns [] for missing/corrupt metadata and never throws', () => {
    expect(importedSmartArtFromMetadata(undefined)).toEqual([]);
    expect(importedSmartArtFromMetadata('')).toEqual([]);
    expect(importedSmartArtFromMetadata('not json')).toEqual([]);
    expect(importedSmartArtFromMetadata(JSON.stringify({ not: 'array' }))).toEqual([]);
    expect(importedSmartArtFromMetadata(JSON.stringify([{ bogus: 1 }]))).toEqual([]);
  });
});

describe('familyToLayout', () => {
  it('covers all seven families', () => {
    expect(familyToLayout('list')).toBe('list');
    expect(familyToLayout('process')).toBe('process');
    expect(familyToLayout('cycle')).toBe('cycle');
    expect(familyToLayout('hierarchy')).toBe('hierarchy');
    expect(familyToLayout('relationship')).toBe('relationship');
    expect(familyToLayout('pyramid')).toBe('pyramid');
    expect(familyToLayout('matrix')).toBe('matrix');
  });
});

describe('importedSmartArtToPicture', () => {
  it('renders the diagram text into an SVG picture at the anchor position', () => {
    const pic = importedSmartArtToPicture(diagram(), 42);
    expect(pic.id).toBe(42);
    expect(pic.sheet).toBe('Sheet1');
    expect(pic.dataUrl.startsWith('data:image/svg+xml')).toBe(true);
    const svg = decodeURIComponent(pic.dataUrl.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('One');
    expect(svg).toContain('Two');
    expect(svg).not.toContain('fffbe6'); // no fallback caption for exact maps
    expect(pic.x).toBe(64);
    expect(pic.y).toBe(40);
  });

  it('bakes the fallback note into the SVG as a visible caption', () => {
    const pic = importedSmartArtToPicture(
      diagram({
        layoutId: 'mysticFunnelWidget',
        layoutName: 'Mystic Funnel Widget',
        fallbackNote: 'SmartArt layout "Mystic Funnel Widget" (mysticFunnelWidget) has no exact layout renderer; rendered as Process (closest match).',
      }),
      43,
    );
    const svg = decodeURIComponent(pic.dataUrl.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('closest match');
    expect(svg).toContain('Mystic Funnel Widget');
  });

  it('uses a deterministic overlay name for save/re-open dedup', () => {
    expect(importedSmartArtPictureName(diagram())).toBe(
      importedSmartArtPictureName(diagram()),
    );
    expect(importedSmartArtPictureName(diagram())).toContain('Basic Process');
  });
});

describe('smartArtPartsFromMetadata', () => {
  it('passes through well-formed raw parts and drops garbage', () => {
    const parts = { diagrams: [{ sheetName: 'S' }], parts: { 'xl/diagrams/data1.xml': 'eA==' } };
    expect(smartArtPartsFromMetadata(parts)).toBe(parts);
    expect(smartArtPartsFromMetadata(undefined)).toBeUndefined();
    expect(smartArtPartsFromMetadata({})).toBeUndefined();
    expect(smartArtPartsFromMetadata({ diagrams: [] })).toBeUndefined();
  });
});

describe('smartArtLayoutMappingReport', () => {
  it('reports every diagram — exact and fallback alike', () => {
    const report = smartArtLayoutMappingReport([
      diagram(),
      diagram({ layoutId: 'mysticFunnelWidget', fallbackNote: 'note here' }),
    ]);
    expect(report.length).toBe(2);
    expect(report[0].exact).toBe(true);
    expect(report[0].note).toBe('');
    expect(report[1].exact).toBe(false);
    expect(report[1].note).toBe('note here');
    expect(report[1].family).toBe('process');
  });
});
