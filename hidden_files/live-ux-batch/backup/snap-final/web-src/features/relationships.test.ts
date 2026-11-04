import { describe, expect, it } from 'vitest';
import {
  createRelationship,
  loadRelationships,
  relatedLookup,
  relationshipFormula,
  saveRelationships,
  validateRelationship,
  type TableDef,
} from './relationships';

const CUSTOMERS: TableDef = {
  name: 'Customers',
  headers: ['CustID', 'Name'],
  rows: [['C1', 'Acme'], ['C2', 'Globex']],
};
const ORDERS: TableDef = {
  name: 'Orders',
  headers: ['OrderID', 'CustID', 'Total'],
  rows: [['O1', 'C1', '100'], ['O2', 'C1', '50'], ['O3', 'C2', '75']],
};
const TABLES = [CUSTOMERS, ORDERS];

describe('validateRelationship', () => {
  it('accepts a valid relationship', () => {
    expect(validateRelationship(
      { fromTable: 'Orders', fromColumn: 'CustID', toTable: 'Customers', toColumn: 'CustID' },
      TABLES,
    )).toEqual([]);
  });
  it('reports missing tables and columns', () => {
    const errs = validateRelationship(
      { fromTable: 'Orders', fromColumn: 'Nope', toTable: 'Missing', toColumn: 'CustID' },
      TABLES,
    );
    expect(errs.length).toBe(2);
  });
  it('rejects self-join on the same column', () => {
    expect(validateRelationship(
      { fromTable: 'Orders', fromColumn: 'CustID', toTable: 'Orders', toColumn: 'CustID' },
      TABLES,
    ).length).toBeGreaterThan(0);
  });
});

describe('createRelationship', () => {
  it('creates with id and timestamp', () => {
    const rel = createRelationship(
      { fromTable: 'Orders', fromColumn: 'CustID', toTable: 'Customers', toColumn: 'CustID' },
      TABLES,
    );
    expect(rel.id).toMatch(/^rel_/);
    expect(rel.createdAt).toBeTruthy();
  });
  it('throws on invalid spec', () => {
    expect(() => createRelationship(
      { fromTable: 'Orders', fromColumn: 'Nope', toTable: 'Customers', toColumn: 'CustID' },
      TABLES,
    )).toThrow();
  });
});

describe('relatedLookup', () => {
  const rel = createRelationship(
    { fromTable: 'Orders', fromColumn: 'CustID', toTable: 'Customers', toColumn: 'CustID' },
    TABLES,
  );
  it('returns matching values from the one side', () => {
    expect(relatedLookup(rel, TABLES, 'C1', 'Name')).toEqual(['Acme']);
  });
  it('returns empty array when nothing matches', () => {
    expect(relatedLookup(rel, TABLES, 'C9', 'Name')).toEqual([]);
  });
  it('throws for unknown return column', () => {
    expect(() => relatedLookup(rel, TABLES, 'C1', 'Nope')).toThrow();
  });
});

describe('relationshipFormula', () => {
  it('builds an XLOOKUP over the one-side table', () => {
    const rel = createRelationship(
      { fromTable: 'Orders', fromColumn: 'CustID', toTable: 'Customers', toColumn: 'CustID' },
      TABLES,
    );
    expect(relationshipFormula(rel, TABLES, 'B2', 'Name')).toBe(
      '=XLOOKUP(B2,Customers!A2:A3,Customers!B2:B3)',
    );
  });
});

describe('persistence', () => {
  it('round-trips through a storage-like', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const rel = createRelationship(
      { fromTable: 'Orders', fromColumn: 'CustID', toTable: 'Customers', toColumn: 'CustID' },
      TABLES,
    );
    saveRelationships([rel], store);
    expect(loadRelationships(store)).toEqual([rel]);
  });
});
