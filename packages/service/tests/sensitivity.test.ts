/**
 * Tests for the sensitivity label model (packages/service/src/sensitivity.ts):
 * label storage, canShare/canDownload enforcement (face c: authorize-style
 * access control, not encryption), hidden-cell filtered views (face e), and
 * audit logging.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  SensitivityStore,
  createSensitivityStore,
  isSensitivityLabel,
  labelRank,
  SENSITIVITY_LABELS,
} from '../src/sensitivity';
import { memoryPersistence } from '../src/metadataStore';
import { KeyManager } from '../src/crypto';

function keys() {
  return new KeyManager(memoryPersistence());
}

let store: SensitivityStore;
beforeEach(async () => {
  store = await createSensitivityStore(memoryPersistence(), keys());
});

describe('label model', () => {
  it('defaults to public', async () => {
    expect(store.getLabel()).toBe('public');
  });

  it('round-trips setLabel/getLabel and records the changer', async () => {
    await store.setLabel('confidential', 'alice');
    expect(store.getLabel()).toBe('confidential');
    const audit = store.auditLog();
    expect(audit.some((e) => e.action === 'set-label' && e.principal === 'alice')).toBe(true);
  });

  it('validates label constants', async () => {
    expect(SENSITIVITY_LABELS).toEqual(['public', 'internal', 'confidential']);
    expect(isSensitivityLabel('internal')).toBe(true);
    expect(isSensitivityLabel('top-secret')).toBe(false);
    expect(labelRank('public')).toBeLessThan(labelRank('internal'));
    expect(labelRank('internal')).toBeLessThan(labelRank('confidential'));
  });

  it('survives a fresh store over the same persistence (metadata store pattern)', async () => {
    const p = memoryPersistence();
    const k = keys();
    const a = await createSensitivityStore(p, k);
    await a.setLabel('internal', 'user');
    const b = await createSensitivityStore(p, k);
    expect(b.getLabel()).toBe('internal');
  });

  it('stored bytes are ciphertext, not plaintext', async () => {
    const p = memoryPersistence();
    const s = await createSensitivityStore(p, keys());
    await s.setLabel('confidential', 'alice');
    await s.setOwners(['alice', 'bob'], 'alice');
    const raw = p.load('icecream-sheets.secure.v1/__service__/icecream-sheets.sensitivity.v1');
    expect(raw).not.toBeNull();
    for (const secret of ['confidential', 'alice', 'bob', 'set-label']) {
      expect(raw as string).not.toContain(secret);
    }
    const env = JSON.parse(raw as string) as Record<string, unknown>;
    expect(env.version).toBe(1);
    expect(typeof env.ciphertext).toBe('string');
  });

  it('corrupt stored bytes fail closed (no silent fallback)', async () => {
    const p = memoryPersistence();
    const k = keys();
    const s = await createSensitivityStore(p, k);
    await s.setLabel('internal', 'user');
    p.save('icecream-sheets.secure.v1/__service__/icecream-sheets.sensitivity.v1', 'garbage{');
    await expect(createSensitivityStore(p, k)).rejects.toThrow(/fail closed/);
  });
});

describe('canShare (face c: access control, not encryption)', () => {
  it('public: any authenticated principal may share', async () => {
    expect(await store.canShare('public', 'user')).toBe(true);
    expect(await store.canShare('public', 'guest-123')).toBe(true);
  });

  it('public: anonymous principals are denied (fail closed on identity)', async () => {
    expect(await store.canShare('public', '')).toBe(false);
  });

  it('internal: any authenticated principal may share', async () => {
    expect(await store.canShare('internal', 'user')).toBe(true);
    expect(await store.canShare('internal', '')).toBe(false);
  });

  it('confidential: owners only', async () => {
    expect(await store.canShare('confidential', 'user')).toBe(true); // default owner
    expect(await store.canShare('confidential', 'mallory')).toBe(false);
    await store.setOwners(['alice'], 'user');
    expect(await store.canShare('confidential', 'alice')).toBe(true);
    expect(await store.canShare('confidential', 'user')).toBe(false);
  });
});

describe('canDownload (face c)', () => {
  it('public/internal: any authenticated principal may download', async () => {
    expect(await store.canDownload('public', 'user')).toBe(true);
    expect(await store.canDownload('internal', 'someone')).toBe(true);
    expect(await store.canDownload('internal', '')).toBe(false);
  });

  it('confidential: owners only, denied attempts are audited', async () => {
    expect(await store.canDownload('confidential', 'mallory')).toBe(false);
    expect(await store.canDownload('confidential', 'user')).toBe(true);
    const denied = store.auditLog().filter((e) => e.action === 'download-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].principal).toBe('mallory');
  });
});

describe('applyHiddenView (face e: per-subject filtered views)', () => {
  const values = new Map([
    ['S:0:0', 'visible'],
    ['S:0:1', 'SECRET-VALUE'],
  ]);
  const hidden = new Set(['S:0:1']);

  it('confidential: non-owners get hidden values completely removed', async () => {
    const view = store.applyHiddenView('confidential', values, hidden, 'mallory');
    expect(view.get('S:0:0')).toBe('visible');
    expect(view.has('S:0:1')).toBe(false);
  });

  it('confidential: owners see everything', async () => {
    const view = store.applyHiddenView('confidential', values, hidden, 'user');
    expect(view.get('S:0:1')).toBe('SECRET-VALUE');
  });

  it('non-confidential labels never filter', async () => {
    expect(store.applyHiddenView('internal', values, hidden, 'mallory').get('S:0:1')).toBe('SECRET-VALUE');
    expect(store.applyHiddenView('public', values, hidden, 'mallory').get('S:0:1')).toBe('SECRET-VALUE');
  });

  it('does not mutate the input map', async () => {
    store.applyHiddenView('confidential', values, hidden, 'mallory');
    expect(values.get('S:0:1')).toBe('SECRET-VALUE');
  });
});
