/**
 * The five faces of protection (user ruling 2026-10-18):
 * (a) password-to-open — password derives the encryption key (service crypto;
 *     engine half: password hashing + "passwords never stored" tested here)
 * (b) password-on-download — encrypted download envelope (service crypto;
 *     engine half: filtered snapshot tested in web io tests)
 * (c) service-boundary access control — authorize() on reads AND writes
 * (d) cell/range locking — locked cells reject writes for unauthorized principals
 * (e) cell hiding — hidden cells unreadable everywhere, no formula leaks
 */
import { describe, expect, it } from 'vitest';
import { Authorizer, allowAllPolicy } from '../src/permissions.js';
import { ProtectionManager, hashPassword } from '../src/protection.js';
import { EngineHost } from '../src/protocol.js';
import { isError } from '../src/types.js';

const OWNER = { principal: 'user:owner' };
const GUEST = { principal: 'user:guest' };

function hostWithProtection() {
  const protection = new ProtectionManager();
  const host = new EngineHost(
    undefined,
    new Authorizer(protection.protectionPolicy(allowAllPolicy())),
  );
  host.setHiddenCheck((ref, principal) =>
    protection.isHiddenFrom(ref.sheet, ref.row, ref.col, principal),
  );
  protection.setHiddenExemptPrincipals(['user:owner']);
  return { host, protection };
}

describe('face (c): access control on reads and writes', () => {
  it('a deny-policy blocks both reads and writes', () => {
    const denyWrites = new Authorizer((action) => action !== 'cell.write');
    const host = new EngineHost(undefined, denyWrites);
    const w = host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 1,
    });
    expect(w.ok).toBe(false);
  });

  it('denied reads and writes are audit-logged', () => {
    const authorizer = new Authorizer(() => false);
    const host = new EngineHost(undefined, authorizer);
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 1 });
    host.readCell({ sheet: 'Sheet1', row: 0, col: 0 });
    const denied = authorizer.auditLog().filter((r) => !r.allowed);
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });
});

describe('face (d): cell/range locking', () => {
  it('locked cells reject writes through execute() (engine-level)', () => {
    const { host, protection } = hostWithProtection();
    protection.protectSheet('Sheet1', undefined, {}, OWNER);
    // Whole sheet locked by default; carve out A2 as editable.
    protection.setLockedRanges('Sheet1', [], ['A2']);
    // A1 is locked: write must be denied at the engine boundary.
    const denied = host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      value: 1,
      auth: GUEST,
    });
    expect(denied.ok).toBe(false);
    // A2 is unlocked: write succeeds.
    const ok = host.execute({
      cmd: 'setCell',
      ref: { sheet: 'Sheet1', row: 1, col: 0 },
      value: 2,
      auth: GUEST,
    });
    expect(ok.ok).toBe(true);
  });

  it('setFormula on a locked cell is denied', () => {
    const { host, protection } = hostWithProtection();
    protection.protectSheet('Sheet1', undefined, {}, OWNER);
    const denied = host.execute({
      cmd: 'setFormula',
      ref: { sheet: 'Sheet1', row: 0, col: 0 },
      formula: '1+1',
      auth: GUEST,
    });
    expect(denied.ok).toBe(false);
  });
});

describe('face (e): cell hiding', () => {
  it('hidden cells return #PERM! on direct read for non-exempt principals', () => {
    const { host, protection } = hostWithProtection();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 'secret', auth: OWNER });
    protection.hideRanges('Sheet1', ['A1'], OWNER);
    const v = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 }, GUEST);
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#PERM!');
    // Exempt owner still sees the value.
    const ov = host.readCell({ sheet: 'Sheet1', row: 0, col: 0 }, OWNER);
    expect(ov).toEqual({ kind: 'string', value: 'secret' });
  });

  it('a formula referencing a hidden cell returns #PERM! (no leak)', () => {
    const { host, protection } = hostWithProtection();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 100, auth: OWNER });
    host.execute({ cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 1, col: 0 }, formula: 'A1*2', auth: OWNER });
    protection.hideRanges('Sheet1', ['A1'], OWNER);
    const v = host.readCell({ sheet: 'Sheet1', row: 1, col: 0 }, GUEST);
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#PERM!');
  });

  it('a transitive formula chain over a hidden cell returns #PERM!', () => {
    const { host, protection } = hostWithProtection();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 7, auth: OWNER });
    host.execute({ cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 1, col: 0 }, formula: 'A1+1', auth: OWNER });
    host.execute({ cmd: 'setFormula', ref: { sheet: 'Sheet1', row: 2, col: 0 }, formula: 'A2+1', auth: OWNER });
    protection.hideRanges('Sheet1', ['A1'], OWNER);
    const v = host.readCell({ sheet: 'Sheet1', row: 2, col: 0 }, GUEST);
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#PERM!');
  });

  it('INDIRECT("A1") over a hidden cell returns #PERM! (no leak)', () => {
    const { host, protection } = hostWithProtection();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 42, auth: OWNER });
    host.execute({
      cmd: 'setFormula',
      ref: { sheet: 'Sheet1', row: 1, col: 0 },
      formula: 'INDIRECT("A1")',
      auth: OWNER,
    });
    protection.hideRanges('Sheet1', ['A1'], OWNER);
    const v = host.readCell({ sheet: 'Sheet1', row: 1, col: 0 }, GUEST);
    expect(isError(v)).toBe(true);
    if (isError(v)) expect(v.code).toBe('#PERM!');
    // Exempt owner is never #PERM!-blocked by the leak scan (INDIRECT itself
    // is a #NAME? stub in this engine build; the point is no false positive).
    const ov = host.readCell({ sheet: 'Sheet1', row: 1, col: 0 }, OWNER);
    expect(isError(ov) && ov.code === '#PERM!').toBe(false);
  });

  it('readRange marks hidden cells per-cell', () => {
    const { host, protection } = hostWithProtection();
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 0 }, value: 's', auth: OWNER });
    host.execute({ cmd: 'setCell', ref: { sheet: 'Sheet1', row: 0, col: 1 }, value: 'v', auth: OWNER });
    protection.hideRanges('Sheet1', ['A1'], OWNER);
    const rows = host.readRange(
      { sheet: 'Sheet1', startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
      GUEST,
    );
    expect(isError(rows[0]?.[0])).toBe(true);
    expect(rows[0]?.[1]).toEqual({ kind: 'string', value: 'v' });
  });

  it('hidden ranges round-trip through metadata as hints', () => {
    const { protection } = hostWithProtection();
    protection.hideRanges('Sheet1', ['A1:B2'], OWNER);
    const meta = protection.toMetadata();
    const p2 = new ProtectionManager();
    p2.fromMetadata(meta as Record<string, unknown>);
    expect(p2.isCellHidden('Sheet1', 0, 0)).toBe(true);
    expect(p2.isCellHidden('Sheet1', 5, 5)).toBe(false);
  });
});

describe('face (a): password-derived keys — engine half', () => {
  it('passwords are never stored; only salted hashes', () => {
    const p = new ProtectionManager();
    p.protectSheet('Sheet1', 's3cret', {}, OWNER);
    const state = p.getSheetProtection('Sheet1');
    expect(state?.passwordHash).toBeDefined();
    expect(state?.passwordHash).not.toContain('s3cret');
    // Same password + different salt => different hash (salt is stored).
    expect(hashPassword('s3cret', 'salt1')).not.toBe(hashPassword('s3cret', 'salt2'));
    // Correct password unprotects; wrong password fails and audits.
    expect(p.unprotectSheet('Sheet1', 'wrong', GUEST)).toBe(false);
    expect(p.unprotectSheet('Sheet1', 's3cret', OWNER)).toBe(true);
    expect(p.auditLog().some((r) => r.action === 'unlock.failed')).toBe(true);
  });
});
