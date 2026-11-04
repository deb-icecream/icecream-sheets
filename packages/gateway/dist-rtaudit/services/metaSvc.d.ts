/**
 * Metadata service: generic per-tenant key/value store behind HTTP.
 *
 * Follows the service MetadataStore pattern (packages/service/src/
 * metadataStore.ts) without persisting to disk: keys are namespaced per
 * principal — storage key = `<principal>/<key>` — so one tenant can never
 * read another's values. In-memory persistence for now; prod backs this
 * with the service metadata store backend (durable, encrypted at rest).
 *
 * Endpoints:
 * - GET    /health
 * - GET    /kv/:key      → { value: string | null }
 * - PUT    /kv/:key      { value: string }
 * - DELETE /kv/:key
 *
 * The :key segment may itself contain slashes (everything after /kv/).
 */
import type { RequestListener } from 'node:http';
export declare function createMetaListener(): RequestListener;
