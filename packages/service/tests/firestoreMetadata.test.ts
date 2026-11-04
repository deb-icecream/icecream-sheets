/**
 * Tests for the Firestore-backed MCP metadata persistence
 * (durable-store migration, step 4): FirestoreMetadataPersistence over a
 * fake FirestoreDbLike. Round-trips, missing keys, deletes, the 1 MiB
 * loud-rejection cap, sha256 doc ids, and malformed-document tolerance.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  FirestoreMetadataPersistence,
  MCP_METADATA_COLLECTION,
  MCP_METADATA_DOC_CAP_BYTES,
  mcpMetadataDocId,
  type FirestoreDbLike,
  type FirestoreDocLike,
} from '../src/firestoreMetadata.js';

/** In-memory fake of the Firestore slice the adapter uses. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const seen: string[] = [];
  const db: FirestoreDbLike = {
    collection(name: string) {
      if (name !== MCP_METADATA_COLLECTION) {
        throw new Error(`fakeDb: unexpected collection ${name}`);
      }
      return {
        doc(id: string): FirestoreDocLike {
          seen.push(id);
          return {
            get: async () => ({
              exists: docs.has(id),
              data: () => docs.get(id),
            }),
            set: async (data: Record<string, unknown>) => {
              docs.set(id, data);
              return undefined;
            },
            delete: async () => {
              docs.delete(id);
              return undefined;
            },
          };
        },
      };
    },
  };
  return { db, docs, seen };
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('FirestoreMetadataPersistence', () => {
  it('round-trips save -> load', async () => {
    const { db } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    await expect(p.load('k1')).resolves.toBeNull();
    await p.save('k1', '{"a":1}');
    await expect(p.load('k1')).resolves.toBe('{"a":1}');
  });

  it('uses sha256 hex of the key as the document id', async () => {
    const { db, seen } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    await p.save('some/key:with?special chars \u00e9', 'v');
    expect(seen).toContain(sha256('some/key:with?special chars \u00e9'));
    expect(mcpMetadataDocId('k')).toBe(sha256('k'));
    // Doc ids are always legal: 64 lowercase hex chars.
    expect(mcpMetadataDocId('a/b?c')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clear deletes the document', async () => {
    const { db } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    await p.save('k', 'v');
    await p.clear('k');
    await expect(p.load('k')).resolves.toBeNull();
  });

  it('rejects values over the 1 MiB cap loudly and writes nothing', async () => {
    const { db, docs } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    const tooBig = 'x'.repeat(MCP_METADATA_DOC_CAP_BYTES + 1);
    await expect(p.save('big', tooBig)).rejects.toThrow(/exceeding.*document cap/);
    expect(docs.has(sha256('big'))).toBe(false);
    await expect(p.load('big')).resolves.toBeNull();
  });

  it('accepts a value of exactly the cap size', async () => {
    const { db } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    const exact = 'y'.repeat(MCP_METADATA_DOC_CAP_BYTES);
    await p.save('exact', exact);
    await expect(p.load('exact')).resolves.toBe(exact);
  });

  it('measures the cap in UTF-8 bytes, not characters', async () => {
    const { db } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    // 'é' is 2 bytes in UTF-8: 524289 chars = 1,048,578 bytes > cap.
    const s = '\u00e9'.repeat(524289);
    expect(Buffer.byteLength(s, 'utf8')).toBeGreaterThan(MCP_METADATA_DOC_CAP_BYTES);
    await expect(p.save('wide', s)).rejects.toThrow(/exceeding.*document cap/);
  });

  it('tolerates malformed documents as missing', async () => {
    const { db, docs } = fakeDb();
    const p = new FirestoreMetadataPersistence(db);
    docs.set(sha256('novalue'), { other: 1 });
    docs.set(sha256('nonstr'), { value: 42 });
    await expect(p.load('novalue')).resolves.toBeNull();
    await expect(p.load('nonstr')).resolves.toBeNull();
  });

  it('requires a Firestore client', () => {
    expect(() => new FirestoreMetadataPersistence(null as never)).toThrow(/required/);
  });

  it('propagates Firestore errors (fails closed, never swallows)', async () => {
    const db: FirestoreDbLike = {
      collection: () => ({
        doc: (): FirestoreDocLike => ({
          get: async () => {
            throw new Error('firestore unavailable');
          },
          set: async () => {
            throw new Error('firestore unavailable');
          },
          delete: async () => {
            throw new Error('firestore unavailable');
          },
        }),
      }),
    };
    const p = new FirestoreMetadataPersistence(db);
    await expect(p.load('k')).rejects.toThrow('firestore unavailable');
    await expect(p.save('k', 'v')).rejects.toThrow('firestore unavailable');
    await expect(p.clear('k')).rejects.toThrow('firestore unavailable');
  });
});
