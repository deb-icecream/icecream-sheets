/**
 * Firestore-backed AsyncPersistence for the MCP durable store
 * (durable-store migration, step 4).
 *
 * One Firestore document per metadata key in the `icecream_mcp_metadata`
 * collection; the document id is the sha256 hex of the key (keys may
 * contain slashes/unicode that are illegal or awkward in doc ids).
 * Documents hold `{ value: string }`.
 *
 * Written against a narrow structural interface (FirestoreDbLike) so it
 * unit-tests with fakes; the official @google-cloud/firestore client
 * satisfies this shape. Mirrors the gateway's FirestoreLike pattern
 * (packages/gateway/src/deploy/sessionStore.ts) without importing the
 * gateway (dependency direction: gateway -> service, never the reverse).
 *
 * Durability contract: save() resolves only after the document write is
 * acknowledged. There is no write-through cache and no truncation —
 * values over the 1 MiB document cap are REJECTED LOUDLY (throw), never
 * silently truncated, because a truncated metadata blob is corruption.
 */

import { createHash } from 'node:crypto';
import type { AsyncPersistence } from './secureStore.js';

/** The slice of the Firestore client this adapter uses. */
export interface FirestoreDocLike {
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
}
export interface FirestoreDbLike {
  collection(name: string): { doc(id: string): FirestoreDocLike };
}

/** Firestore collection holding MCP metadata documents. */
export const MCP_METADATA_COLLECTION = 'icecream_mcp_metadata';

/**
 * Firestore single-document read/write ceiling we enforce client-side.
 * Firestore's hard limit is 1,048,576 bytes per document; we reject at
 * exactly that size rather than letting the server reject with a less
 * actionable error.
 */
export const MCP_METADATA_DOC_CAP_BYTES = 1048576;

/** Document id for a metadata key: sha256 hex (always a legal doc id). */
export function mcpMetadataDocId(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * AsyncPersistence over Firestore. Construct with a FirestoreDbLike
 * (real client in prod, fake in tests). Fails closed: any Firestore
 * error propagates to the caller, never swallowed.
 */
export class FirestoreMetadataPersistence implements AsyncPersistence {
  constructor(
    private readonly db: FirestoreDbLike,
    private readonly collectionName: string = MCP_METADATA_COLLECTION,
  ) {
    if (!db) throw new Error('firestoreMetadata: Firestore client is required');
    if (typeof collectionName !== 'string' || collectionName.length === 0) {
      throw new Error('firestoreMetadata: collection name must be a non-empty string');
    }
  }

  /** The Firestore collection this instance reads/writes. */
  get collection(): string {
    return this.collectionName;
  }

  private doc(key: string): FirestoreDocLike {
    return this.db.collection(this.collectionName).doc(mcpMetadataDocId(key));
  }

  async load(key: string): Promise<string | null> {
    const snap = await this.doc(key).get();
    if (!snap.exists) return null;
    const data = snap.data();
    // Tolerance contract (matches the sync/async store convention):
    // a malformed document reads as missing, never throws.
    if (!data || typeof data.value !== 'string') return null;
    return data.value;
  }

  async save(key: string, value: string): Promise<void> {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MCP_METADATA_DOC_CAP_BYTES) {
      throw new Error(
        `firestoreMetadata: value for key "${key}" is ${bytes} bytes, ` +
          `exceeding the ${MCP_METADATA_DOC_CAP_BYTES}-byte document cap; ` +
          `refusing to write rather than truncate`,
      );
    }
    await this.doc(key).set({ value });
  }

  async clear(key: string): Promise<void> {
    await this.doc(key).delete();
  }
}
