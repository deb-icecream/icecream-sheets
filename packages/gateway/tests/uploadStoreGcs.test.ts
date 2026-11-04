/**
 * GCS signed-URL Content-Type binding (#96 reopen): the browser PUT's
 * Content-Type MUST equal the signed URL's bound contentType, or GCS
 * rejects the PUT (403). The gateway binds the format's canonical MIME
 * (grant) and the client sends it verbatim; this unit pins the adapter
 * side: a caller-provided contentType is bound, and the default remains
 * the xlsx MIME for callers that omit it.
 */
import { describe, expect, it } from 'vitest';
import { GcsUploadObjectStore } from '../src/deploy/uploadStore.js';

describe('GcsUploadObjectStore.putUrl contentType binding', () => {
  it('binds the caller-provided contentType; defaults to the xlsx MIME', async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeFile = {
      save: async () => {},
      download: async (): Promise<[Buffer]> => [Buffer.alloc(0)],
      getMetadata: async (): Promise<[Record<string, unknown>]> => [{ size: 0 }],
      delete: async () => {},
      getSignedUrl: async (opts: Record<string, unknown>) => {
        captured = opts;
        return ['https://storage.googleapis.com/bucket/obj?sig=x'];
      },
    };
    const store = new GcsUploadObjectStore(
      { bucket: () => ({ file: () => fakeFile }) } as never,
      { bucket: 'b', tokenSecret: 's' },
    );
    await store.putUrl('obj', { principal: 'u', contentType: 'text/csv' });
    expect((captured as unknown as Record<string, unknown>).contentType).toBe('text/csv');
    await store.putUrl('obj', { principal: 'u' });
    expect((captured as unknown as Record<string, unknown>).contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});
