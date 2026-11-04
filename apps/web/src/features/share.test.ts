import { describe, expect, it } from 'vitest';
import {
  createShare,
  loadShareAudit,
  loadShareRecords,
  revokeShare,
  validateShare,
} from './share';

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('share', () => {
  it('validates input', () => {
    expect(validateShare({ workbook: '', people: [], permission: 'read' }).length).toBeGreaterThan(0);
    expect(validateShare({ workbook: 'W', people: ['not-an-email'], permission: 'read' }).length).toBe(1);
    expect(validateShare({ workbook: 'W', people: ['a@b.com'], permission: 'read' })).toEqual([]);
  });
  it('creates a record with a capability link and audit entry', () => {
    const s = memStore();
    const { record, audit } = createShare(
      { workbook: 'Budget', people: ['a@b.com'], permission: 'read' },
      'user',
      s,
    );
    expect(record.link).toMatch(/^https:\/\/share\.icecream-sheets\.app\/s\/[a-z0-9]{24}$/);
    expect(record.permission).toBe('read');
    expect(record.revoked).toBe(false);
    expect(audit.action).toBe('share.created');
    expect(loadShareRecords(s).length).toBe(1);
    expect(loadShareAudit(s).length).toBe(1);
  });
  it('mints unique tokens', () => {
    const s = memStore();
    const a = createShare({ workbook: 'W', people: ['a@b.com'], permission: 'write' }, 'user', s);
    const b = createShare({ workbook: 'W', people: ['c@d.com'], permission: 'write' }, 'user', s);
    expect(a.record.link).not.toBe(b.record.link);
  });
  it('throws on invalid input', () => {
    expect(() => createShare({ workbook: 'W', people: [], permission: 'read' }, 'user', memStore())).toThrow();
  });
  it('revokes and audits', () => {
    const s = memStore();
    const { record } = createShare({ workbook: 'W', people: ['a@b.com'], permission: 'read' }, 'user', s);
    const audit = revokeShare(record.id, 'user', s);
    expect(audit.action).toBe('share.revoked');
    expect(loadShareRecords(s)[0].revoked).toBe(true);
    expect(loadShareAudit(s).length).toBe(2);
  });
});
