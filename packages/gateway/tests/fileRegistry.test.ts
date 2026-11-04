/**
 * Phase 2 ownership registry (§9): CAS claims, epoch fencing,
 * heartbeat semantics, fail-closed IO. Design doc:
 * revision-model-save-and-coauthoring.md §9; CONTRACT.md (fileRegistry).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalFileRegistry,
  MemoryFileRegistry,
  createFileRegistry,
  isLiveOwner,
  type FileRegistryRecord,
} from '../src/deploy/fileRegistry.js';

function rec(fileId: string, epoch: number, over: Partial<FileRegistryRecord> = {}): FileRegistryRecord {
  return {
    fileId,
    sessionId: `sess_${fileId}`,
    ownerInstance: 'engine-1',
    ownerEndpoint: 'http://127.0.0.1:8101',
    leaseExpiry: Date.now() + 30_000,
    ownershipEpoch: epoch,
    currentRevision: 0,
    storedRevision: 0,
    updatedAt: Date.now(),
    creatorPrincipal: 'user:alice',
    ...over,
  };
}

describe('file registry (memory + local adapters)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function both() {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-freg-'));
    dirs.push(dir);
    return [
      ['memory', new MemoryFileRegistry()] as const,
      ['local', new LocalFileRegistry(dir)] as const,
    ];
  }

  it('CAS race: exactly one winner among concurrent first claims', async () => {
    for (const [name, registry] of both()) {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          registry.claim(rec('file-race', 1, { sessionId: `sess_${i}`, ownerInstance: `engine-${i}` }), null),
        ),
      );
      expect(results.filter(Boolean), name).toHaveLength(1);
      const stored = await registry.lookup('file-race');
      expect(stored?.ownershipEpoch, name).toBe(1);
    }
  });

  it('claim against a stale expected epoch loses; the epoch increments per transfer', async () => {
    for (const [, registry] of both()) {
      expect(await registry.claim(rec('file-a', 1), null)).toBe(true);
      // Second claim with expectedEpoch=null (thinks no record) loses.
      expect(await registry.claim(rec('file-a', 1, { sessionId: 'sess_other' }), null)).toBe(false);
      // Claim with the WRONG expected epoch loses.
      expect(await registry.claim(rec('file-a', 2, { sessionId: 'sess_other' }), 7)).toBe(false);
      // Takeover with the correct expected epoch wins and bumps epoch.
      expect(
        await registry.claim(rec('file-a', 2, { sessionId: 'sess_new', ownerInstance: 'engine-2' }), 1),
      ).toBe(true);
      const stored = await registry.lookup('file-a');
      expect(stored?.ownershipEpoch).toBe(2);
      expect(stored?.sessionId).toBe('sess_new');
    }
  });

  it('heartbeat: current owner refreshes lease + revisions; a fenced owner gets false', async () => {
    for (const [, registry] of both()) {
      await registry.claim(rec('file-hb', 1), null);
      const before = await registry.lookup('file-hb');
      expect(await registry.heartbeat('file-hb', 'sess_file-hb', 1, 12, 10)).toBe(true);
      const after = await registry.lookup('file-hb');
      expect(after?.currentRevision).toBe(12);
      expect(after?.storedRevision).toBe(10);
      expect(after!.leaseExpiry).toBeGreaterThanOrEqual(before!.leaseExpiry);
      // Takeover: epoch 2.
      await registry.claim(rec('file-hb', 2, { sessionId: 'sess_takeover' }), 1);
      // The OLD owner's heartbeat now reports fencing.
      expect(await registry.heartbeat('file-hb', 'sess_file-hb', 1, 13, 10)).toBe(false);
      // Wrong session with the right epoch is also fenced.
      expect(await registry.heartbeat('file-hb', 'sess_file-hb', 2, 13, 10)).toBe(false);
      // The new owner's heartbeat succeeds.
      expect(await registry.heartbeat('file-hb', 'sess_takeover', 2, 13, 10)).toBe(true);
    }
  });

  it('release clears the lease but keeps the epoch for the next CAS', async () => {
    for (const [, registry] of both()) {
      await registry.claim(rec('file-rel', 1), null);
      expect(await registry.release('file-rel', 'sess_file-rel', 1)).toBe(true);
      const stored = await registry.lookup('file-rel');
      expect(stored).not.toBeNull();
      expect(isLiveOwner(stored)).toBe(false);
      expect(stored?.ownershipEpoch).toBe(1);
      // Next claim must CAS against epoch 1 → epoch 2.
      expect(await registry.claim(rec('file-rel', 1, { sessionId: 'sess_x' }), null)).toBe(false);
      expect(await registry.claim(rec('file-rel', 2, { sessionId: 'sess_x' }), 1)).toBe(true);
      // Release by a non-owner is refused.
      expect(await registry.release('file-rel', 'sess_file-rel', 1)).toBe(false);
    }
  });

  it('noteParticipant records joiners with roles on the live record only', async () => {
    for (const [name, registry] of both()) {
      await registry.claim(rec('file-p', 1), null);
      // A joiner is recorded with the role their join token carried.
      expect(
        await registry.noteParticipant('file-p', 'sess_file-p', 1, 'user:bob', 'viewer'),
        name,
      ).toBe(true);
      expect(await registry.noteParticipant('file-p', 'sess_file-p', 1, 'user:carol', 'editor'), name).toBe(true);
      let stored = await registry.lookup('file-p');
      expect(stored?.participants, name).toEqual({ 'user:bob': 'viewer', 'user:carol': 'editor' });
      // Ownership fields untouched.
      expect(stored?.sessionId, name).toBe('sess_file-p');
      expect(stored?.ownershipEpoch, name).toBe(1);
      expect(stored?.creatorPrincipal, name).toBe('user:alice');
      // A re-join refreshes the role (promotion viewer → editor).
      expect(await registry.noteParticipant('file-p', 'sess_file-p', 1, 'user:bob', 'editor'), name).toBe(true);
      stored = await registry.lookup('file-p');
      expect(stored?.participants?.['user:bob'], name).toBe('editor');
      // Heartbeats preserve participants.
      expect(await registry.heartbeat('file-p', 'sess_file-p', 1, 5, 5), name).toBe(true);
      stored = await registry.lookup('file-p');
      expect(stored?.participants?.['user:carol'], name).toBe('editor');
      // Wrong session / wrong epoch: not recorded.
      expect(await registry.noteParticipant('file-p', 'sess_other', 1, 'user:dave', 'editor'), name).toBe(false);
      expect(await registry.noteParticipant('file-p', 'sess_file-p', 9, 'user:dave', 'editor'), name).toBe(false);
      // Released (dead lease): not recorded.
      expect(await registry.release('file-p', 'sess_file-p', 1), name).toBe(true);
      expect(await registry.noteParticipant('file-p', 'sess_file-p', 1, 'user:dave', 'editor'), name).toBe(false);
      // A fresh claim replaces the record wholesale: participants reset.
      expect(await registry.claim(rec('file-p', 2, { sessionId: 'sess_new' }), 1), name).toBe(true);
      stored = await registry.lookup('file-p');
      expect(stored?.participants, name).toBeUndefined();
    }
  });

  it('local adapter: a second instance over the same dir sees the same records (shared DB)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-freg-'));
    dirs.push(dir);
    const a = new LocalFileRegistry(dir);
    const b = new LocalFileRegistry(dir);
    await a.claim(rec('file-shared', 1), null);
    expect((await b.lookup('file-shared'))?.sessionId).toBe('sess_file-shared');
    expect(await b.claim(rec('file-shared', 1, { sessionId: 'sess_sneak' }), null)).toBe(false);
  });

  it('local adapter fails closed on a corrupt registry file (IO/parse errors throw)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icecream-freg-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'file-registry.json'), '{ not json', 'utf8');
    const registry = new LocalFileRegistry(dir);
    await expect(registry.lookup('file-x')).rejects.toThrow();
    await expect(registry.claim(rec('file-x', 1), null)).rejects.toThrow();
  });

  it('prod provider fails closed without an injected Firestore client', () => {
    expect(() =>
      createFileRegistry({ SESSION_STORE: 'prod' } as NodeJS.ProcessEnv),
    ).toThrowError(/fail closed/);
    expect(() =>
      createFileRegistry({ FILE_REGISTRY_STORE: 'prod' } as NodeJS.ProcessEnv),
    ).toThrowError(/fail closed/);
  });
});
