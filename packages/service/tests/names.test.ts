/**
 * Tests for NamedRangeStore (design-docs/named-ranges-and-named-functions.md
 * §§1–5): stable ids, scope/shadowing, case-insensitivity, collision
 * rejection, cell-ref/function-name rejection, permissions, dangling refs,
 * engine sync, and XLSX round-trip.
 */
import { describe, expect, it } from 'vitest';
import {
  NamedRangeStore,
  NameError,
  KeyManager,
  memoryPersistence,
  validateNameSyntax,
  isValidDefinedName,
  type AuthorizeFn,
  type CreateNamedRangeStoreOptions,
  type NameRangeRef,
} from '../src/index.js';

const PRINCIPAL = 'user:alice';
const WB = 'wb-test';

const ref = (sheet: string, sr: number, sc: number, er: number, ec: number): NameRangeRef => ({
  sheet,
  startRow: sr,
  startCol: sc,
  endRow: er,
  endCol: ec,
});

function keys() {
  return new KeyManager(memoryPersistence());
}

async function store(
  opts: Partial<CreateNamedRangeStoreOptions> = {},
): Promise<NamedRangeStore> {
  return NamedRangeStore.create({ persistence: memoryPersistence(), workbookId: WB, keys: keys(), ...opts });
}

/** Allow-all policy probe. */
const allowAll: AuthorizeFn = () => true;
/** Deny-read policy: writes allowed, reads denied. */
const denyRead: AuthorizeFn = (action) => !action.includes('read');

describe('name validation (§2)', () => {
  it('accepts ordinary names', async () => {
    expect(isValidDefinedName('Sales')).toBe(true);
    expect(isValidDefinedName('_private')).toBe(true);
    expect(isValidDefinedName('My.Name_2')).toBe(true);
  });

  it('rejects cell references (A1 and R1C1 shapes)', async () => {
    expect(isValidDefinedName('A1')).toBe(false);
    expect(isValidDefinedName('XFD1048576')).toBe(false);
    expect(isValidDefinedName('R1C1')).toBe(false);
    expect(isValidDefinedName('r12c5')).toBe(false);
    expect(isValidDefinedName('C')).toBe(false);
    expect(isValidDefinedName('R')).toBe(false);
  });

  it('rejects bad syntax', async () => {
    expect(isValidDefinedName('')).toBe(false);
    expect(isValidDefinedName('1abc')).toBe(false);
    expect(isValidDefinedName('has space')).toBe(false);
    expect(isValidDefinedName('has-dash')).toBe(false);
  });

  it('rejects function names via the reserved set', async () => {
    expect(() =>
      validateNameSyntax('sum', { reservedNames: new Set(['SUM']) }),
    ).toThrowError(NameError);
    expect(isValidDefinedName('SUM', { reservedNames: new Set(['SUM']) })).toBe(false);
  });
});

describe('define / stable ids (§1)', () => {
  it('assigns a stable id independent of the cells', async () => {
    const s = await store();
    const d = await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    expect(d.id).toMatch(/^nr:/);
    expect(d.name).toBe('Sales');
    expect(d.ref).toEqual(ref('Sheet1', 0, 0, 9, 0));
    // Redefine: the id is unchanged (formulas follow the identity).
    const d2 = await s.redefine(d.id, ref('Sheet1', 0, 0, 4, 2), PRINCIPAL);
    expect(d2.id).toBe(d.id);
    expect(d2.ref).toEqual(ref('Sheet1', 0, 0, 4, 2));
  });

  it('persists across instances (metadata store, keyed by id)', async () => {
    const persistence = memoryPersistence();
    const k = keys();
    const s1 = await NamedRangeStore.create({ persistence, workbookId: WB, keys: k });
    const d = await s1.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    const s2 = await NamedRangeStore.create({ persistence, workbookId: WB, keys: k });
    expect(s2.get(d.id)?.name).toBe('Sales');
    // A different workbook id sees nothing (per-workbook keys).
    const s3 = await NamedRangeStore.create({ persistence, workbookId: 'wb-other', keys: k });
    expect(s3.get(d.id)).toBeUndefined();
  });

  it('stored bytes are ciphertext, not plaintext (per-workbook key)', async () => {
    const persistence = memoryPersistence();
    const s = await NamedRangeStore.create({ persistence, workbookId: WB, keys: keys() });
    await s.define({ name: 'SecretSales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    const raw = persistence.load(`icecream-sheets.secure.v1/${WB}/icecream-sheets.names.v1`);
    expect(raw).not.toBeNull();
    for (const secret of ['SecretSales', 'Sheet1', PRINCIPAL]) {
      expect(raw as string).not.toContain(secret);
    }
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });

  it('rename keeps the id; rename to a colliding name is rejected', async () => {
    const s = await store();
    const a = await s.define({ name: 'Alpha', ref: ref('Sheet1', 0, 0, 1, 1), principal: PRINCIPAL });
    await s.define({ name: 'Beta', ref: ref('Sheet1', 2, 2, 3, 3), principal: PRINCIPAL });
    const renamed = await s.rename(a.id, 'Alpha2', PRINCIPAL);
    expect(renamed.id).toBe(a.id);
    expect(renamed.name).toBe('Alpha2');
    await expect(s.rename(a.id, 'Beta', PRINCIPAL)).rejects.toThrowError(/already exists/);
  });
});

describe('scope rules (§2)', () => {
  it('is case-insensitive', async () => {
    const s = await store();
    await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 1, 1), principal: PRINCIPAL });
    expect(s.resolve('sales')?.name).toBe('Sales');
    expect(s.resolve('SALES')?.name).toBe('Sales');
    // Collision is case-insensitive too.
    await expect(s.define({ name: 'SALES', ref: ref('Sheet1', 0, 0, 1, 1), principal: PRINCIPAL })).rejects.toThrowError(/already exists/);
  });

  it('sheet scope shadows the workbook name within that sheet', async () => {
    const s = await store();
    await s.define({ name: 'Total', ref: ref('Sheet1', 0, 0, 0, 0), principal: PRINCIPAL });
    await s.define({
      name: 'Total',
      scope: { kind: 'sheet', sheet: 'Sheet2' },
      ref: ref('Sheet2', 5, 5, 5, 5),
      principal: PRINCIPAL,
    });
    // No collision: shadowing is allowed.
    expect(s.resolve('Total', 'Sheet2')?.ref?.sheet).toBe('Sheet2');
    expect(s.resolve('Total', 'Sheet1')?.ref?.sheet).toBe('Sheet1');
    expect(s.resolve('Total')?.ref?.sheet).toBe('Sheet1');
  });

  it('rejects same-scope collisions, never silently renames', async () => {
    const s = await store();
    await s.define({ name: 'Dup', ref: ref('Sheet1', 0, 0, 0, 0), principal: PRINCIPAL });
    await expect(s.define({ name: 'dup', ref: ref('Sheet1', 1, 1, 1, 1), principal: PRINCIPAL })).rejects.toThrowError(NameError);
    // The original is untouched.
    expect(s.resolve('Dup')?.ref).toEqual(ref('Sheet1', 0, 0, 0, 0));
  });

  it('rejects sheet-scope collisions on the same sheet only', async () => {
    const s = await store();
    await s.define({
      name: 'X',
      scope: { kind: 'sheet', sheet: 'S1' },
      ref: ref('S1', 0, 0, 0, 0),
      principal: PRINCIPAL,
    });
    await expect(s.define({
        name: 'x',
        scope: { kind: 'sheet', sheet: 'S1' },
        ref: ref('S1', 1, 1, 1, 1),
        principal: PRINCIPAL,
      })).rejects.toThrowError(/already exists/);
    // Different sheet: fine.
    await s.define({
      name: 'X',
      scope: { kind: 'sheet', sheet: 'S2' },
      ref: ref('S2', 0, 0, 0, 0),
      principal: PRINCIPAL,
    });
    expect(s.resolve('X', 'S2')?.ref?.sheet).toBe('S2');
  });
});

describe('permissions (§4)', () => {
  it('defining requires write on the range', async () => {
    const denyWrite: AuthorizeFn = (action) => !action.includes('write');
    const s = await store({ authorize: denyWrite });
    await expect(s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL })).rejects.toThrowError(/lacks write/);
  });

  it('allows define with write granted', async () => {
    const s = await store({ authorize: allowAll });
    const d = await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    expect(d.name).toBe('Sales');
  });

  it('resolveForSubject: unknown / ok / denied / dangling', async () => {
    const s = await store({ authorize: denyRead });
    const d = await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    expect(s.resolveForSubject('Nope', PRINCIPAL).status).toBe('unknown');
    expect(s.resolveForSubject('Sales', PRINCIPAL).status).toBe('denied');
    // Dangling: import a #REF! name, then resolve.
    const { imported } = await s.importDefinedNames(
      [{ name: 'Gone', ref: '#REF!' }],
      ['Sheet1'],
      PRINCIPAL,
    );
    expect(imported).toHaveLength(1);
    const r = s.resolveForSubject('Gone', PRINCIPAL);
    expect(r.status).toBe('dangling');
    expect(r.status === 'dangling' && r.def.ref).toBeNull();
    void d;
  });

  it('resolveForSubject ok when reads allowed', async () => {
    const s = await store({ authorize: allowAll });
    await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    const r = s.resolveForSubject('sales', PRINCIPAL);
    expect(r.status).toBe('ok');
  });
});

describe('XLSX round-trip (§3)', () => {
  it('toDefinedNames mirrors with scope indices; dangling → #REF!', async () => {
    const s = await store();
    await s.define({ name: 'Wb', ref: ref('Sheet1', 0, 0, 1, 1), principal: PRINCIPAL });
    await s.define({
      name: 'Local',
      scope: { kind: 'sheet', sheet: 'Sheet2' },
      ref: ref('Sheet2', 0, 0, 0, 0),
      principal: PRINCIPAL,
    });
    await s.importDefinedNames([{ name: 'Gone', ref: '#REF!' }], ['Sheet1'], PRINCIPAL);
    const dns = s.toDefinedNames(['Sheet1', 'Sheet2']);
    const wb = dns.find((d) => d.name === 'Wb')!;
    expect(wb.sheet).toBeUndefined();
    expect(wb.ref).toBe('=Sheet1!$A$1:$B$2');
    const local = dns.find((d) => d.name === 'Local')!;
    expect(local.sheet).toBe(1);
    const gone = dns.find((d) => d.name === 'Gone')!;
    expect(gone.ref).toBe('#REF!');
  });

  it('importDefinedNames: fresh ids, skips non-ranges and collisions', async () => {
    const s = await store();
    const { imported, skipped } = await s.importDefinedNames(
      [
        { name: 'North', ref: "'Sheet1'!$A$1:$A$5" },
        { name: 'South2', ref: "'Sheet2'!$B$2", sheet: 1 },
        { name: 'NotARange', ref: 'Sheet1!$A$1+100' },
        { name: 'ALambda', ref: 'LAMBDA(x,x*2)' },
        { name: 'Bad Sheet', ref: "'Nope'!$A$1", sheet: 9 },
      ],
      ['Sheet1', 'Sheet2'],
      PRINCIPAL,
    );
    expect(imported).toHaveLength(2);
    const r1 = s.resolve('North')!;
    expect(r1.ref).toEqual(ref('Sheet1', 0, 0, 4, 0));
    expect(r1.id).toMatch(/^nr:/);
    const r2 = s.resolve('South2', 'Sheet2')!;
    expect(r2.scope).toEqual({ kind: 'sheet', sheet: 'Sheet2' });
    expect(skipped.map((x) => x.name).sort()).toEqual(['ALambda', 'Bad Sheet', 'NotARange']);
    // Re-import collides → skipped, never renamed.
    const again = await s.importDefinedNames([{ name: 'north', ref: "'Sheet1'!$A$1" }], ['Sheet1'], PRINCIPAL);
    expect(again.imported).toHaveLength(0);
    expect(again.skipped[0]!.reason).toMatch(/collides/);
  });
});

describe('structural shifts (§1: identity tracks insert/delete/move)', () => {
  it('insert rows shifts ranges at/below, expands spanning ranges', async () => {
    const s = await store();
    const below = await s.define({ name: 'Below', ref: ref('S', 5, 0, 7, 0), principal: PRINCIPAL });
    const span = await s.define({ name: 'Span', ref: ref('S', 3, 0, 6, 0), principal: PRINCIPAL });
    const above = await s.define({ name: 'Above', ref: ref('S', 0, 0, 1, 0), principal: PRINCIPAL });
    await s.applyInsertRows('S', 4, 2);
    expect(s.get(below.id)?.ref).toEqual(ref('S', 7, 0, 9, 0));
    expect(s.get(span.id)?.ref).toEqual(ref('S', 3, 0, 8, 0));
    expect(s.get(above.id)?.ref).toEqual(ref('S', 0, 0, 1, 0));
  });

  it('delete rows shrinks, shifts, and dangles fully-deleted ranges', async () => {
    const s = await store();
    const all = await s.define({ name: 'All', ref: ref('S', 3, 0, 5, 0), principal: PRINCIPAL });
    const part = await s.define({ name: 'Part', ref: ref('S', 0, 0, 4, 0), principal: PRINCIPAL });
    const below = await s.define({ name: 'Below', ref: ref('S', 6, 0, 8, 0), principal: PRINCIPAL });
    await s.applyDeleteRows('S', 3, 3); // deletes rows 3,4,5
    expect(s.get(all.id)?.ref).toBeNull(); // dangling → #REF!
    expect(s.resolveForSubject('All', PRINCIPAL).status).toBe('dangling');
    expect(s.get(part.id)?.ref).toEqual(ref('S', 0, 0, 2, 0));
    expect(s.get(below.id)?.ref).toEqual(ref('S', 3, 0, 5, 0));
  });

  it('delete then re-insert never rebinds a dangling name', async () => {
    const s = await store();
    const d = await s.define({ name: 'All', ref: ref('S', 3, 0, 5, 0), principal: PRINCIPAL });
    await s.applyDeleteRows('S', 3, 3);
    expect(s.get(d.id)?.ref).toBeNull();
    await s.applyInsertRows('S', 3, 3); // cells move back in — the name stays dangling
    expect(s.get(d.id)?.ref).toBeNull();
  });

  it('move rows carries ranges inside the block', async () => {
    const s = await store();
    const d = await s.define({ name: 'Block', ref: ref('S', 2, 0, 3, 0), principal: PRINCIPAL });
    await s.applyMoveRows('S', 2, 2, 6); // rows 2-3 → post-removal index 6
    expect(s.get(d.id)?.ref).toEqual(ref('S', 6, 0, 7, 0));
  });

  it('cols shift independently; other sheets untouched', async () => {
    const s = await store();
    const d = await s.define({ name: 'Col', ref: ref('S', 0, 2, 0, 4), principal: PRINCIPAL });
    const other = await s.define({ name: 'Oth', ref: ref('T', 0, 2, 0, 4), principal: PRINCIPAL });
    await s.applyDeleteCols('S', 0, 2);
    expect(s.get(d.id)?.ref).toEqual(ref('S', 0, 0, 0, 2));
    expect(s.get(other.id)?.ref).toEqual(ref('T', 0, 2, 0, 4));
  });

  it('snapshot/restore round-trips defs (undo)', async () => {
    const s = await store();
    const d = await s.define({ name: 'X', ref: ref('S', 0, 0, 1, 1), principal: PRINCIPAL });
    const snap = s.snapshotDefs();
    await s.applyDeleteRows('S', 0, 2);
    expect(s.get(d.id)?.ref).toBeNull();
    await s.restoreDefs(snap);
    expect(s.get(d.id)?.ref).toEqual(ref('S', 0, 0, 1, 1));
  });

  it('deleteSheetRefs dangles refs on the deleted sheet, keeps others', async () => {
    const s = await store();
    const gone = await s.define({ name: 'Gone', ref: ref('Old', 0, 0, 3, 0), principal: PRINCIPAL });
    const kept = await s.define({ name: 'Kept', ref: ref('S', 0, 0, 3, 0), principal: PRINCIPAL });
    await s.deleteSheetRefs('Old');
    expect(s.get(gone.id)?.ref).toBeNull();
    expect(s.resolveForSubject('Gone', PRINCIPAL).status).toBe('dangling');
    expect(s.get(kept.id)?.ref).toEqual(ref('S', 0, 0, 3, 0));
  });

  it('deleteSheetRefs is case-insensitive on the sheet name', async () => {
    const s = await store();
    const d = await s.define({ name: 'X', ref: ref('Old', 0, 0, 1, 1), principal: PRINCIPAL });
    await s.deleteSheetRefs('oLd');
    expect(s.get(d.id)?.ref).toBeNull();
  });
});

describe('engine sync (§1: syncFromEngine)', () => {
  it('syncFromEngine refreshes refs; #REF! → dangling', async () => {
    const s = await store();
    const d = await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 9, 0), principal: PRINCIPAL });
    // Engine moved the range (row inserted above).
    await s.syncFromEngine(
      () => '=Sheet1!$A$2:$A$11',
      () => 0,
    );
    expect(s.get(d.id)?.ref).toEqual(ref('Sheet1', 1, 0, 10, 0));
    // All cells deleted → dangling, never rebound.
    await s.syncFromEngine(() => '=#REF!', () => 0);
    const after = s.get(d.id)!;
    expect(after.ref).toBeNull();
    expect(s.resolveForSubject('Sales', PRINCIPAL).status).toBe('dangling');
  });

  it('renameSheet updates scope and ref sheets', async () => {
    const s = await store();
    const d = await s.define({
      name: 'L',
      scope: { kind: 'sheet', sheet: 'Old' },
      ref: ref('Old', 0, 0, 0, 0),
      principal: PRINCIPAL,
    });
    await s.renameSheet('Old', 'New');
    const after = s.get(d.id)!;
    expect(after.scope).toEqual({ kind: 'sheet', sheet: 'New' });
    expect(after.ref?.sheet).toBe('New');
    expect(s.resolve('L', 'New')?.id).toBe(d.id);
  });

  it('undefine removes the name', async () => {
    const s = await store({ authorize: allowAll });
    const d = await s.define({ name: 'Sales', ref: ref('Sheet1', 0, 0, 1, 1), principal: PRINCIPAL });
    await s.undefine(d.id, PRINCIPAL);
    expect(s.resolve('Sales')).toBeUndefined();
    expect(s.list()).toHaveLength(0);
  });
});
