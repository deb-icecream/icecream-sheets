import { describe, expect, it } from 'vitest';
import {
  PERM_DENIED_CELL,
  canSubjectReadCell,
  canSubjectWriteCell,
  canViewReport,
  reportCellTarget,
  filterBindingRecordsForSubject,
  filterReportForSubject,
  reportRangeTarget,
  subjectCellAccess,
  type AuthorizePort,
  type ReportBinding,
  type ReportSpec,
} from '../src/index.js';

const binding: ReportBinding = {
  id: 'b1',
  name: 'Sales',
  sheet: 'Sheet1',
  startRow: 0,
  startCol: 0,
  endRow: 3,
  endCol: 2,
  headerRow: 0,
  fields: ['Region', 'Sales', 'Units'],
};

/** Policy: deny cell.read on Sheet1!B3 (row 2, col 1); deny cell.write on the whole sheet. */
function policyWithHiddenCell(): AuthorizePort {
  return (action, target, ctx) => {
    void ctx;
    if (action === 'cell.read') return target !== 'Sheet1!B3';
    if (action === 'cell.write') return false;
    return true;
  };
}

const allowAll: AuthorizePort = () => true;

const records = [
  { Region: 'East', Sales: 100, Units: 10 },
  { Region: 'West', Sales: 200, Units: 20 },
  { Region: 'North', Sales: 300, Units: 30 },
];

describe('reportCellTarget / reportRangeTarget', () => {
  it('formats A1 targets', () => {
    expect(reportCellTarget('Sheet1', 0, 0)).toBe('Sheet1!A1');
    expect(reportCellTarget('Sheet1', 2, 1)).toBe('Sheet1!B3');
    expect(reportCellTarget('Sheet1', 0, 26)).toBe('Sheet1!AA1');
    expect(reportRangeTarget('Sheet1', 0, 0, 3, 2)).toBe('Sheet1!A1:C4');
  });
});

describe('filterBindingRecordsForSubject', () => {
  it('replaces unreadable cells with #PERM!', () => {
    const out = filterBindingRecordsForSubject(binding, records, policyWithHiddenCell(), 'viewer');
    // Sheet1!B3 = record index 1 (row 2), field 'Sales' (col 1).
    expect(out[0]).toEqual(records[0]);
    expect(out[1]).toEqual({ Region: 'West', Sales: PERM_DENIED_CELL, Units: 20 });
    expect(out[2]).toEqual(records[2]);
  });

  it('does not mutate the input records', () => {
    const copy = records.map((r) => ({ ...r }));
    filterBindingRecordsForSubject(binding, records, policyWithHiddenCell(), 'viewer');
    expect(records).toEqual(copy);
  });

  it('passes everything through when the subject may read all cells', () => {
    const out = filterBindingRecordsForSubject(binding, records, allowAll, 'owner');
    expect(out).toEqual(records);
  });

  it('fails closed on a throwing policy and on a missing principal', () => {
    const throwing: AuthorizePort = () => {
      throw new Error('boom');
    };
    const out = filterBindingRecordsForSubject(binding, records, throwing, 'viewer');
    expect(out.every((r) => Object.values(r).every((v) => v === PERM_DENIED_CELL))).toBe(true);
    expect(() => filterBindingRecordsForSubject(binding, records, allowAll, '')).toThrow();
  });
});

describe('filterReportForSubject', () => {
  it('filters every binding of a report spec', () => {
    const spec = {
      bindings: [binding],
    } as ReportSpec;
    const out = filterReportForSubject(spec, () => records, policyWithHiddenCell(), 'viewer');
    expect(out.get('b1')?.[1]?.Sales).toBe(PERM_DENIED_CELL);
    expect(out.get('b1')?.[0]).toEqual(records[0]);
  });
});

describe('subjectCellAccess', () => {
  it('reports read vs write separately (locked cells are read-only)', () => {
    const access = subjectCellAccess(policyWithHiddenCell(), 'Sheet1', 0, 0, 'viewer');
    expect(access.readable).toBe(true);
    expect(access.writable).toBe(false);
    const hidden = subjectCellAccess(policyWithHiddenCell(), 'Sheet1', 2, 1, 'viewer');
    expect(hidden.readable).toBe(false);
  });

  it('canSubjectReadCell / canSubjectWriteCell reject a missing principal', () => {
    expect(() => canSubjectReadCell(allowAll, 'S', 0, 0, '')).toThrow();
    expect(() => canSubjectWriteCell(allowAll, 'S', 0, 0, '')).toThrow();
  });
});

describe('canViewReport', () => {
  const spec = { bindings: [binding] } as ReportSpec;

  it('allows a subject that can read all binding ranges', () => {
    expect(canViewReport(spec, allowAll, 'viewer')).toBe(true);
  });

  it('denies when any binding range is unreadable', () => {
    const deny: AuthorizePort = (action) => action !== 'cell.read';
    expect(canViewReport(spec, deny, 'viewer')).toBe(false);
  });

  it('allows reports with no bindings', () => {
    expect(canViewReport({ bindings: [] } as ReportSpec, allowAll, 'viewer')).toBe(true);
  });

  it('fails closed on a throwing policy or missing principal', () => {
    const throwing: AuthorizePort = () => {
      throw new Error('boom');
    };
    expect(canViewReport(spec, throwing, 'viewer')).toBe(false);
    expect(() => canViewReport(spec, allowAll, '')).toThrow();
  });
});
