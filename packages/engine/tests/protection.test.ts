/**
 * Tests for workbook/sheet protection (track 19,
 * design-docs/workbook-protection-and-encryption.md).
 */
import { describe, expect, it } from 'vitest';
import {
  ProtectionManager,
  hashPassword,
  randomSalt,
  sha256Hex,
} from '../src/protection.js';

describe('sha256Hex', () => {
  it('matches the known SHA-256 of empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('is deterministic', () => {
    expect(sha256Hex('password123')).toBe(sha256Hex('password123'));
  });
});

describe('password hashing', () => {
  it('salted hashes differ per salt', () => {
    const s1 = randomSalt();
    const s2 = randomSalt();
    expect(s1).not.toBe(s2);
    expect(hashPassword('secret', s1)).not.toBe(hashPassword('secret', s2));
  });
  it('same password+salt verifies', () => {
    const salt = randomSalt();
    expect(hashPassword('hunter2', salt)).toBe(hashPassword('hunter2', salt));
  });
});

describe('ProtectionManager sheet protection', () => {
  it('protects and unprotects with password', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('Sheet1', 'pw');
    expect(pm.isSheetProtected('Sheet1')).toBe(true);
    expect(pm.unprotectSheet('Sheet1', 'wrong')).toBe(false);
    expect(pm.isSheetProtected('Sheet1')).toBe(true);
    expect(pm.unprotectSheet('Sheet1', 'pw')).toBe(true);
    expect(pm.isSheetProtected('Sheet1')).toBe(false);
  });

  it('protects without a password', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('S', undefined);
    expect(pm.isSheetProtected('S')).toBe(true);
    expect(pm.unprotectSheet('S', undefined)).toBe(true);
  });

  it('locks all cells by default when protected', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('S', undefined);
    expect(pm.isCellEditable('S', 0, 0)).toBe(false);
    expect(pm.isCellEditable('Other', 0, 0)).toBe(true);
  });

  it('unlocked ranges are editable', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('S', undefined);
    pm.setLockedRanges('S', [], ['B2:C3']);
    expect(pm.isCellEditable('S', 1, 1)).toBe(true); // B2
    expect(pm.isCellEditable('S', 0, 0)).toBe(false); // A1
  });

  it('audit-logs protect/unprotect and failed unlocks', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('S', 'pw', {}, { principal: 'alice' });
    pm.unprotectSheet('S', 'bad', { principal: 'bob' });
    const log = pm.auditLog();
    expect(log.map((r) => r.action)).toEqual(['sheet.protect', 'unlock.failed']);
    expect(log[1].principal).toBe('bob');
  });
});

describe('ProtectionManager workbook protection', () => {
  it('protects structure', () => {
    const pm = new ProtectionManager();
    pm.protectWorkbook('pw');
    expect(pm.isWorkbookProtected()).toBe(true);
    expect(pm.unprotectWorkbook('nope')).toBe(false);
    expect(pm.unprotectWorkbook('pw')).toBe(true);
    expect(pm.isWorkbookProtected()).toBe(false);
  });
});

describe('protectionPolicy', () => {
  function policyFor(pm: ProtectionManager) {
    return pm.protectionPolicy(() => true);
  }

  it('denies writes to locked cells', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('S', undefined);
    const policy = policyFor(pm);
    expect(policy('cell.write', 'S!A1', { principal: 'u' })).toBe(false);
    expect(policy('cell.write', 'Other!A1', { principal: 'u' })).toBe(true);
  });

  it('denies sheet structure changes when protected', () => {
    const pm = new ProtectionManager();
    pm.protectWorkbook(undefined);
    const policy = policyFor(pm);
    expect(policy('sheet.add', 'New', { principal: 'u' })).toBe(false);
    expect(policy('sheet.delete', 'S', { principal: 'u' })).toBe(false);
    expect(policy('sheet.rename', 'S', { principal: 'u' })).toBe(false);
    expect(policy('cell.write', 'S!A1', { principal: 'u' })).toBe(true);
  });

  it('defers to inner policy otherwise', () => {
    const pm = new ProtectionManager();
    const policy = pm.protectionPolicy(() => false);
    expect(policy('cell.write', 'S!A1', { principal: 'u' })).toBe(false);
  });
});

describe('protection metadata round-trip', () => {
  it('serializes and restores flags without passwords', () => {
    const pm = new ProtectionManager();
    pm.protectSheet('S', 'secret');
    pm.protectWorkbook('wsecret');
    const meta = pm.toMetadata();
    // Password hashes must NOT travel in metadata.
    expect(JSON.stringify(meta)).not.toContain('secret');

    const pm2 = new ProtectionManager();
    pm2.fromMetadata(meta);
    expect(pm2.isSheetProtected('S')).toBe(true);
    expect(pm2.isWorkbookProtected()).toBe(true);
    // Restored without password: unprotect succeeds with undefined.
    expect(pm2.unprotectSheet('S', undefined)).toBe(true);
  });
});
