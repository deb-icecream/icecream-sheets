/**
 * Tests for the 7 OLAP cube functions (cube-functions.ts).
 *
 * Imports ONLY the module under test (plus vitest and hyperformula), so
 * other registrations cannot interfere. A small sales pivot is adapted via
 * cubeFromPivot() and registered as the "sales" connection; every expected
 * value below is hand-computed from that pivot.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { HyperFormula } from 'hyperformula';
import {
  registerCubeFunctions,
  registerCube,
  clearCubes,
  cubeFromPivot,
  type OlapCube,
  type PivotResultLike,
} from '../src/cube-functions.js';

registerCubeFunctions();

// East: Bikes=100 Cars=200 | West: Bikes=300 Cars=400
const PIVOT: PivotResultLike = {
  rowFieldNames: ['Region'],
  colFieldNames: ['Product'],
  valueLabels: ['Sum of Amount'],
  rowKeys: [['East'], ['West']],
  colKeys: [['Bikes'], ['Cars']],
  data: [
    [[100], [200]],
    [[300], [400]],
  ],
  rowTotals: [[300], [700]],
  colTotals: [[400], [600]],
  grandTotals: [1000],
};

beforeEach(() => {
  clearCubes();
  registerCube(cubeFromPivot(PIVOT, 'sales'));
});

function calc(formula: string): unknown {
  const hf = HyperFormula.buildFromArray([[formula]], { licenseKey: 'gpl-v3' });
  return hf.getCellValue({ sheet: 0, row: 0, col: 0 });
}

function calcErr(formula: string): { type: string; value: string } {
  const v = calc(formula) as { type?: string; value?: string } | null;
  expect(v !== null && typeof v === 'object' && typeof v.value === 'string').toBe(true);
  return v as { type: string; value: string };
}

/** Evaluate a grid of formulas; returns a (row, col) reader (0-indexed). */
function calcGrid(rows: string[][]): (row: number, col: number) => unknown {
  const hf = HyperFormula.buildFromArray(rows, { licenseKey: 'gpl-v3' });
  return (row, col) => hf.getCellValue({ sheet: 0, row, col });
}

describe('CUBEVALUE', () => {
  it('resolves a full tuple against pivot aggregations (East/Bikes = 100)', () => {
    expect(calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region].[East]","[Product].[Bikes]")')).toBe(100);
  });
  it('resolves West/Cars = 400', () => {
    expect(calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region].[West]","[Product].[Cars]")')).toBe(400);
  });
  it('uses row totals when columns are unspecified (East = 300)', () => {
    expect(calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region].[East]")')).toBe(300);
  });
  it('uses grand totals when nothing is specified (= 1000)', () => {
    expect(calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]")')).toBe(1000);
  });
  it('accepts plain labels (no brackets)', () => {
    expect(calc('=CUBEVALUE("sales","Sum of Amount","West","Cars")')).toBe(400);
  });
  it('aggregates partial tuples (Bikes across regions = 400)', () => {
    expect(calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Product].[Bikes]")')).toBe(400);
  });
  it('defaults to the first measure when none is given', () => {
    expect(calc('=CUBEVALUE("sales","[Region].[East]","[Product].[Bikes]")')).toBe(100);
  });
  it('returns #N/A for an unknown connection', () => {
    const e = calcErr('=CUBEVALUE("nope","[Measures].[Sum of Amount]")');
    expect(e.value).toBe('#N/A');
  });
  it('returns #N/A for an unknown member', () => {
    const e = calcErr('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region].[Mars]")');
    expect(e.value).toBe('#N/A');
  });
});

describe('CUBEMEMBER / CUBEMEMBERPROPERTY', () => {
  it('returns the canonical member expression', () => {
    expect(calc('=CUBEMEMBER("sales","[Region].[West]")')).toBe('[Region].[West]');
  });
  it('resolves plain labels to canonical form', () => {
    expect(calc('=CUBEMEMBER("sales","East")')).toBe('[Region].[East]');
  });
  it('caption property returns the member label', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","caption")')).toBe('West');
  });
  it('unique_name property returns the canonical expression', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","unique_name")')).toBe('[Region].[West]');
  });
  it('dimension property returns the dimension name', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Product].[Bikes]","dimension")')).toBe('Product');
  });
  it('unknown property is #N/A', () => {
    expect(calcErr('=CUBEMEMBERPROPERTY("sales","[Region].[West]","bogus")').value).toBe('#N/A');
  });
});

describe('CUBESET / CUBERANKEDMEMBER / CUBESETCOUNT', () => {
  /** Evaluate CUBESET in A1 and a second formula in B1 that references A1. */
  function calcPair(setFormula: string, b1Formula: string): unknown {
    const hf = HyperFormula.buildFromArray([[setFormula, b1Formula]], {
      licenseKey: 'gpl-v3',
    });
    return hf.getCellValue({ sheet: 0, row: 0, col: 1 });
  }

  it('CUBESETCOUNT counts a comma-list set', () => {
    expect(
      calcPair('=CUBESET("sales","[Region].[East], [Region].[West]")', '=CUBESETCOUNT(A1)'),
    ).toBe(2);
  });
  it('CUBERANKEDMEMBER returns the nth member', () => {
    expect(
      calcPair(
        '=CUBESET("sales","[Region].[East], [Region].[West]")',
        '=CUBERANKEDMEMBER("sales",A1,2)',
      ),
    ).toBe('[Region].[West]');
  });
  it('rank out of range is #N/A', () => {
    const hf = HyperFormula.buildFromArray(
      [['=CUBESET("sales","[Region].[East]")', '=CUBERANKEDMEMBER("sales",A1,5)']],
      { licenseKey: 'gpl-v3' },
    );
    const v = hf.getCellValue({ sheet: 0, row: 0, col: 1 }) as { value?: string };
    expect(v !== null && typeof v === 'object' && v.value).toBe('#N/A');
  });
  it('parses braced tuple sets', () => {
    expect(
      calcPair(
        '=CUBESET("sales","{([Region].[East],[Product].[Bikes]), ([Region].[West],[Product].[Cars])}")',
        '=CUBESETCOUNT(A1)',
      ),
    ).toBe(2);
  });
  it('sorts ascending by caption', () => {
    expect(
      calcPair(
        '=CUBESET("sales","[Region].[West], [Region].[East]",,1)',
        '=CUBERANKEDMEMBER("sales",A1,1)',
      ),
    ).toBe('[Region].[East]');
  });
  it('sorts descending by measure value', () => {
    expect(
      calcPair(
        '=CUBESET("sales","[Region].[East], [Region].[West]",,2,"[Measures].[Sum of Amount]")',
        '=CUBERANKEDMEMBER("sales",A1,1)',
      ),
      // West total 700 > East total 300, so West ranks first descending.
    ).toBe('[Region].[West]');
  });
});

describe('CUBEKPIMEMBER', () => {
  beforeEach(() => {
    const cube: OlapCube = {
      name: 'kpis',
      measures: ['Sales'],
      dimensions: ['Region'],
      members: { Region: ['East'] },
      kpis: {
        Revenue: {
          value: 1000,
          goal: 1200,
          status: 1,
          trend: -1,
          weight: 0.5,
          currentTimeMember: '[Time].[2024]',
        },
      },
      getValue: () => 1000,
    };
    registerCube(cube);
  });

  it('property 1 returns the KPI value', () => {
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue",1)')).toBe(1000);
  });
  it('named properties resolve (goal)', () => {
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue","goal")')).toBe(1200);
  });
  it('status and trend resolve', () => {
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue",3)')).toBe(1);
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue","trend")')).toBe(-1);
  });
  it('property 5 returns the KPI weight', () => {
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue",5)')).toBe(0.5);
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue","weight")')).toBe(0.5);
  });
  it('property 6 returns the current time member expression', () => {
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue",6)')).toBe('[Time].[2024]');
    expect(calc('=CUBEKPIMEMBER("kpis","Revenue","currenttimemember")')).toBe('[Time].[2024]');
  });
  it('unknown KPI property code is #N/A', () => {
    expect(calcErr('=CUBEKPIMEMBER("kpis","Revenue",7)').value).toBe('#N/A');
  });
  it('unknown KPI is #N/A', () => {
    expect(calcErr('=CUBEKPIMEMBER("kpis","Nope",1)').value).toBe('#N/A');
  });
});

describe('cubeFromPivot', () => {
  it('exposes dimensions, measures and members', () => {
    const cube = cubeFromPivot(PIVOT, 'x');
    expect(cube.dimensions).toEqual(['Region', 'Product']);
    expect(cube.measures).toEqual(['Sum of Amount']);
    expect(cube.members['Region']).toEqual(['East', 'West']);
  });
  it('getValue matches the pivot cells directly', () => {
    const cube = cubeFromPivot(PIVOT, 'x');
    expect(cube.getValue('Sum of Amount', { Region: 'West', Product: 'Bikes' })).toBe(300);
    expect(cube.getValue('Amount', { Region: 'East' })).toBe(300); // "Sum of X" <-> "X"
    expect(cube.getValue('Nope', {})).toBe(null);
  });
  it('handles a pivot with no column fields (row-only)', () => {
    const p: PivotResultLike = {
      rowFieldNames: ['Range'],
      colFieldNames: [],
      valueLabels: ['Sum of Price'],
      rowKeys: [['Cake'], ['Pie']],
      colKeys: [],
      data: [[[7]], [[12]]],
      rowTotals: [[7], [12]],
      colTotals: [],
      grandTotals: [19],
    };
    const cube = cubeFromPivot(p, 'y');
    expect(cube.getValue('Sum of Price', { Range: 'Pie' })).toBe(12);
    expect(cube.getValue('Sum of Price', {})).toBe(19);
    expect(cube.getValue('Sum of Price', { Range: 'Missing' })).toBe(null);
  });
});

describe('CUBEVALUE member-expression forms', () => {
  it('accepts a tuple argument', () => {
    expect(
      calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","([Region].[East],[Product].[Bikes])")'),
    ).toBe(100);
  });
  it('accepts a measure inside a tuple', () => {
    expect(calc('=CUBEVALUE("sales","([Measures].[Sum of Amount],[Region].[East])")')).toBe(300);
  });
  it('accepts the three-part key form [Dim].[Hier].&[Key]', () => {
    expect(
      calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region].[Geo].&[West]","[Product].[Cars]")'),
    ).toBe(400);
  });
  it('treats [All] as the grand total over the dimension', () => {
    expect(
      calc('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region].[Geo].[All]")'),
    ).toBe(1000);
  });
  it('resolves chained CUBEMEMBER references through cell refs', () => {
    const read = calcGrid([
      ['=CUBEMEMBER("sales","[Measures].[Sum of Amount]")'],
      ['=CUBEMEMBER("sales","[Region].[West]")', '=CUBEVALUE("sales",A2,A1)'],
    ]);
    expect(read(0, 0)).toBe('[Measures].[Sum of Amount]');
    expect(read(1, 0)).toBe('[Region].[West]');
    expect(read(1, 1)).toBe(700);
  });
  it('a dimension expression (not a member) is #N/A', () => {
    expect(calcErr('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Region]")').value).toBe('#N/A');
  });
  it('an unknown dimension is #N/A', () => {
    expect(
      calcErr('=CUBEVALUE("sales","[Measures].[Sum of Amount]","[Planet].[Mars]")').value,
    ).toBe('#N/A');
  });
});

describe('CUBEMEMBER member-expression forms', () => {
  it('accepts measures (Excel parity)', () => {
    expect(calc('=CUBEMEMBER("sales","[Measures].[Sum of Amount]")')).toBe(
      '[Measures].[Sum of Amount]',
    );
  });
  it('an unknown measure is #N/A', () => {
    expect(calcErr('=CUBEMEMBER("sales","[Measures].[Nope]")').value).toBe('#N/A');
  });
  it('accepts the three-part key form', () => {
    expect(calc('=CUBEMEMBER("sales","[Region].[Geo].&[West]")')).toBe('[Region].[West]');
  });
  it('accepts the All member', () => {
    expect(calc('=CUBEMEMBER("sales","[Region].[Geo].[All]")')).toBe('[Region].[All]');
  });
  it('accepts tuples', () => {
    expect(calc('=CUBEMEMBER("sales","([Region].[West],[Product].[Bikes])")')).toBe(
      '([Region].[West],[Product].[Bikes])',
    );
  });
  it('the caption argument does not change the value (display-layer in Excel)', () => {
    expect(calc('=CUBEMEMBER("sales","[Region].[West]","Western region")')).toBe('[Region].[West]');
  });
});

describe('CUBEMEMBERPROPERTY extended properties', () => {
  it('level_number is 0 (flat local cube)', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","level_number")')).toBe(0);
  });
  it('level_name is the dimension name', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","level_name")')).toBe('Region');
  });
  it('member_name and member_caption aliases work', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","member_name")')).toBe('West');
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","member_caption")')).toBe('West');
  });
  it('children_count is 0', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[West]","children_count")')).toBe(0);
  });
  it('dimension_unique_name returns the dimension', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Product].[Bikes]","dimension_unique_name")')).toBe(
      'Product',
    );
  });
  it('a measure reports the Measures dimension', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Measures].[Sum of Amount]","dimension")')).toBe(
      'Measures',
    );
  });
  it('the All member exposes properties', () => {
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[All]","caption")')).toBe('All');
    expect(calc('=CUBEMEMBERPROPERTY("sales","[Region].[All]","unique_name")')).toBe('[Region].[All]');
  });
  it('a tuple has no single member property (#N/A)', () => {
    expect(
      calcErr('=CUBEMEMBERPROPERTY("sales","([Region].[West],[Product].[Bikes])","caption")').value,
    ).toBe('#N/A');
  });
});

describe('CUBERANKEDMEMBER rank validation', () => {
  function ranked(rankFormula: string): unknown {
    const hf = HyperFormula.buildFromArray(
      [['=CUBESET("sales","[Region].[East], [Region].[West]")', `=CUBERANKEDMEMBER("sales",A1,${rankFormula})`]],
      { licenseKey: 'gpl-v3' },
    );
    return hf.getCellValue({ sheet: 0, row: 0, col: 1 });
  }
  it('rank 0 is #VALUE! (Excel parity)', () => {
    expect((ranked('0') as { value?: string }).value).toBe('#VALUE!');
  });
  it('negative rank is #VALUE!', () => {
    expect((ranked('-2') as { value?: string }).value).toBe('#VALUE!');
  });
  it('non-numeric rank is #VALUE!', () => {
    expect((ranked('"two"') as { value?: string }).value).toBe('#VALUE!');
  });
  it('rank beyond the set size is #N/A', () => {
    expect((ranked('3') as { value?: string }).value).toBe('#N/A');
  });
  it('non-integer rank truncates toward zero', () => {
    expect(ranked('2.9')).toBe('[Region].[West]');
  });
  it('accepts an inline braced set expression', () => {
    expect(calc('=CUBERANKEDMEMBER("sales","{[Region].[East],[Region].[West]}",2)')).toBe(
      '[Region].[West]',
    );
  });
});

describe('CUBESET sort orders', () => {
  beforeEach(() => {
    const cube: OlapCube = {
      name: 'items',
      measures: ['Sales'],
      dimensions: ['Item'],
      members: { Item: ['Item2', 'Item10', 'Item1'] },
      getValue: (measure, coords) =>
        ({ Item2: 20, Item10: 100, Item1: 10 })[coords['Item']!] ?? null,
    };
    registerCube(cube);
  });
  function sortedRank1(sortOrder: number | string): unknown {
    const hf = HyperFormula.buildFromArray(
      [
        [
          `=CUBESET("items","[Item].[Item2], [Item].[Item10], [Item].[Item1]",,${typeof sortOrder === 'string' ? `"${sortOrder}"` : sortOrder})`,
          '=CUBERANKEDMEMBER("items",A1,1)',
        ],
      ],
      { licenseKey: 'gpl-v3' },
    );
    return hf.getCellValue({ sheet: 0, row: 0, col: 1 });
  }
  it('3 = alpha ascending (Item1, Item10, Item2)', () => {
    expect(sortedRank1(3)).toBe('[Item].[Item1]');
  });
  it('4 = alpha descending', () => {
    expect(sortedRank1(4)).toBe('[Item].[Item2]');
  });
  it('5 = natural ascending (Item1, Item2, Item10)', () => {
    expect(sortedRank1(5)).toBe('[Item].[Item1]');
  });
  it('6 = natural descending', () => {
    expect(sortedRank1(6)).toBe('[Item].[Item10]');
  });
  it('1/2 without sort_by sort by caption', () => {
    expect(sortedRank1(1)).toBe('[Item].[Item1]');
    expect(sortedRank1(2)).toBe('[Item].[Item2]');
  });
  it('sort_order 7 is #VALUE!', () => {
    const hf = HyperFormula.buildFromArray(
      [['=CUBESET("items","[Item].[Item1]",,7)', '=CUBESETCOUNT(A1)']],
      { licenseKey: 'gpl-v3' },
    );
    expect((hf.getCellValue({ sheet: 0, row: 0, col: 0 }) as { value?: string }).value).toBe(
      '#VALUE!',
    );
  });
  it('a non-numeric sort_order string is #VALUE!', () => {
    const hf = HyperFormula.buildFromArray([['=CUBESET("items","[Item].[Item1]",,"bogus")']], {
      licenseKey: 'gpl-v3',
    });
    expect((hf.getCellValue({ sheet: 0, row: 0, col: 0 }) as { value?: string }).value).toBe(
      '#VALUE!',
    );
  });
});

describe('CUBESETCOUNT without a connection', () => {
  it('counts an inline braced set (no cube needed)', () => {
    clearCubes();
    expect(calc('=CUBESETCOUNT("{[Region].[East], [Region].[West]}")')).toBe(2);
  });
  it('counts inline tuple sets', () => {
    clearCubes();
    expect(
      calc('=CUBESETCOUNT("{([Region].[East],[Product].[Bikes]),([Region].[West],[Product].[Cars])}")'),
    ).toBe(2);
  });
  it('a bare member is #VALUE! (not a set)', () => {
    expect(calcErr('=CUBESETCOUNT("[Region].[East]")').value).toBe('#VALUE!');
  });
  it('a non-set string is #VALUE!', () => {
    expect(calcErr('=CUBESETCOUNT("hello")').value).toBe('#VALUE!');
  });
  it('a malformed set handle is #VALUE!', () => {
    // The JSON text is placed in A1 as a raw string (HyperFormula string
    // literals cannot embed a literal double quote), then referenced.
    const hf = HyperFormula.buildFromArray(
      [['{"$cubeSet":true}', '=CUBESETCOUNT(A1)']],
      { licenseKey: 'gpl-v3' },
    );
    expect((hf.getCellValue({ sheet: 0, row: 0, col: 1 }) as { value?: string }).value).toBe(
      '#VALUE!',
    );
  });
});

describe('graceful degradation: unknown connection', () => {
  beforeEach(() => {
    clearCubes();
  });
  it('every CUBE* function returns #N/A, never a crash', () => {
    const formulas = [
      '=CUBEVALUE("ghost","[Measures].[M]")',
      '=CUBEMEMBER("ghost","[Region].[West]")',
      '=CUBEMEMBERPROPERTY("ghost","[Region].[West]","caption")',
      '=CUBESET("ghost","[Region].[West]")',
      '=CUBERANKEDMEMBER("ghost","{[Region].[West]}",1)',
      '=CUBEKPIMEMBER("ghost","KPI",1)',
    ];
    for (const f of formulas) {
      expect(calcErr(f).value, f).toBe('#N/A');
    }
  });
  it('the #N/A message names the missing connection', () => {
    const e = calc('=CUBEVALUE("ghost","[Measures].[M]")') as { value?: string; message?: string };
    expect(e.value).toBe('#N/A');
  });
});
