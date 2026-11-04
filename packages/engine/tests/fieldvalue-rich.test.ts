import { describe, expect, it } from 'vitest';
import { HyperFormula } from 'hyperformula';
import {
  clearRichValueFieldValueEntities,
  registerExtendedFunctions10,
  registerRichValueFieldValueEntities,
  richValueToFieldValueEntity,
} from '../src/extended-functions10.js';

registerExtendedFunctions10();

function calc(formula: string): unknown {
  const hf = HyperFormula.buildFromArray([[formula]], { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function calcErr(formula: string): string {
  // getCellValue surfaces errors as HyperFormula's DetailedCellError
  // ({ value: '#N/A', type: 'NA', ... }), not a CellError instance.
  const v = calc(formula) as { type?: string; value?: string } | null;
  expect(v).not.toBeNull();
  expect(typeof v).toBe('object');
  expect(typeof v!.value).toBe('string');
  return v!.type as string;
}

// Adapter ResolvedRichValue shape, structurally (engine must not import
// the adapter package): a stock record whose display text is "MSFT".
const MSFT_RICH = {
  fields: [
    { key: '_Self', value: 'MSFT' },
    { key: 'Name', value: 'Microsoft Corporation' },
    { key: 'Price', value: 428.15 },
    { key: 'Change', value: -2.31 },
    { key: 'Is Active', value: true },
  ],
  fallback: 'MSFT',
};

describe('phase 2 FIELDVALUE rich-value binding', () => {
  it('converts a resolved rich value to a FIELDVALUE entity', () => {
    const entity = richValueToFieldValueEntity(MSFT_RICH);
    expect(entity.keys).toEqual(['msft']);
    expect(entity.fields['price']).toBe(428.15);
    expect(entity.fields['isactive']).toBe(true);
    expect(entity.fields['name']).toBe('Microsoft Corporation');
  });

  it('FIELDVALUE resolves registered rich values by display text, with normalized field names', () => {
    registerRichValueFieldValueEntities([MSFT_RICH]);
    try {
      expect(calc('=FIELDVALUE("MSFT","Price")')).toBe(428.15);
      expect(calcErr('=FIELDVALUE("MSFT","market cap")')).toBe('NA');
      expect(calc('=FIELDVALUE("msft","price")')).toBe(428.15);
      expect(calc('=FIELDVALUE("MSFT","Is Active")')).toBe(true);
    } finally {
      clearRichValueFieldValueEntities();
    }
    // Cleared: MSFT falls back to the bundled sample provider (512.30),
    // proving the registry no longer shadows it.
    expect(calc('=FIELDVALUE("MSFT","price")')).toBe(512.3);
  });

  it('unregistered cells keep the sample provider; unknown rich fields error', () => {
    registerRichValueFieldValueEntities([MSFT_RICH]);
    try {
      expect(calc('=FIELDVALUE("AAPL","price")')).toBe(258.4);
      expect(calcErr('=FIELDVALUE("MSFT","bogus")')).toBe('NA');
    } finally {
      clearRichValueFieldValueEntities();
    }
  });
});
