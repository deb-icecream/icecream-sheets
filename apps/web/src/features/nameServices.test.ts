// @vitest-environment jsdom
/**
 * Item H / round-trip audit D3 — defined names must reach the service
 * name store on open.
 *
 * Defect: `useNameServices.importFromDefinedNames` (the hook over
 * `importDefinedNames` here) had NO caller in the app, so the
 * NamedRangeStore stayed empty for every opened file. The Download
 * dialog reads ONLY that store (`nameServices.services.ranges.list()`
 * in App.tsx), so it claimed "No defined names in this workbook yet"
 * for files carrying 40 (perf-p75) and 512 (drawing file) defined
 * names, and named-range download could never find a file's names.
 * The fix wires the import into `hydrateOpenedWorkbook` (App.tsx),
 * which every open path (local / desktop / gateway, deferred +
 * terminal hydration) funnels through. These tests pin the store-side
 * contract that wiring relies on, using the perf-p75 name shapes:
 * plain-range names import with parsed refs + scope, #REF! imports
 * dangling, non-range names (connection names, constants, LAMBDAs)
 * are skipped — never guessed — and a second import (the terminal
 * hydration re-running after the deferred one) imports nothing twice.
 */
import { describe, expect, it } from 'vitest';
import { createNameServices, importDefinedNames } from './nameServices';
import type { DefinedNameLike } from '@icecream-sheets/service';

const SHEETS = ['FMTs', 'Cover', 'TOC', 'Constants', 'Imports', 'Inputs', 'Calcs', 'Income'];

/** The perf-p75 defined-name shapes (test-data/perf-fixtures/perf-p75.xlsx). */
const P75_NAMES: DefinedNameLike[] = [
  { name: 'Accounts_Payable', ref: 'Inputs!$B$7' },
  { name: 'Tax_Rate', ref: 'Inputs!$B$14' },
  { name: 'Currency', ref: 'Constants!$F$7' },
  // Sheet-scoped (index 6 = 'Calcs'), Excel's internal filter name shape.
  { name: '_xlnm._FilterDatabase', ref: 'Calcs!$AF$6:$AO$16', sheet: 6 },
  // Dangling in the source file: imports as dangling, listed but unusable.
  { name: 'Exact', ref: 'Constants!#REF!' },
  // Connection names: not plain ranges — must be skipped, not guessed.
  { name: '_xlcn.WorksheetConnection_BXL3Way2.xlsxtblPAUI1', ref: 'tblPAA[]' },
  // Constant / expression names are not ranges either.
  { name: 'Doubled', ref: 'Constants!$B$7*2' },
  { name: 'Fn', ref: 'LAMBDA(x,x+1)' },
];

describe('defined names on open (Item H)', () => {
  it('imports the file\u2019s range names into the store the Download dialog reads', async () => {
    const services = await createNameServices(`itemh-${Date.now()}`);
    expect(services.ranges.list()).toEqual([]);
    const { imported, skipped } = await importDefinedNames(services, P75_NAMES, SHEETS);
    const list = services.ranges.list();
    const byName = new Map(list.map((d) => [d.name, d]));

    // Every plain-range name is present — the dialog's source is no
    // longer empty for a names-rich file.
    for (const name of ['Accounts_Payable', 'Tax_Rate', 'Currency', 'Exact']) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(imported.length).toBe(list.length);

    // Refs parse to real ranges (the dialog's refLabel + the named-
    // range download both consume these).
    const ap = byName.get('Accounts_Payable')!;
    expect(ap.scope).toEqual({ kind: 'workbook' });
    expect(ap.ref).toEqual({ sheet: 'Inputs', startRow: 6, startCol: 1, endRow: 6, endCol: 1 });

    // The dangling name imports as dangling (ref null → the dialog
    // lists it disabled as #REF!, exactly like a user-created one).
    expect(byName.get('Exact')!.ref).toBeNull();

    // Non-range names are skipped with reasons, never half-imported.
    const skippedNames = skipped.map((s) => s.name);
    expect(skippedNames).toContain('_xlcn.WorksheetConnection_BXL3Way2.xlsxtblPAUI1');
    expect(skippedNames).toContain('Doubled');
    expect(skippedNames).toContain('Fn');
    expect(byName.has('_xlcn.WorksheetConnection_BXL3Way2.xlsxtblPAUI1')).toBe(false);
  });

  it('is idempotent: a second import (terminal hydration) duplicates nothing', async () => {
    const services = await createNameServices(`itemh2-${Date.now()}`);
    await importDefinedNames(services, P75_NAMES, SHEETS);
    const firstCount = services.ranges.list().length;
    expect(firstCount).toBeGreaterThan(0);
    const again = await importDefinedNames(services, P75_NAMES, SHEETS);
    expect(again.imported).toEqual([]);
    expect(services.ranges.list().length).toBe(firstCount);
  });

  it('round-trips: imported names export back to defined names for save', async () => {
    const services = await createNameServices(`itemh3-${Date.now()}`);
    await importDefinedNames(services, P75_NAMES, SHEETS);
    const { exportDefinedNames } = await import('./nameServices');
    const exported = exportDefinedNames(services, SHEETS);
    const names = exported.map((d) => d.name);
    expect(names).toContain('Accounts_Payable');
    expect(names).toContain('Tax_Rate');
    const ap = exported.find((d) => d.name === 'Accounts_Payable')!;
    expect(ap.ref).toContain('Inputs!');
    expect(ap.ref).toContain('$B$7');
  });
});
