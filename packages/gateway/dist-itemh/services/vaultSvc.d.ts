/**
 * Vault service: credential storage behind HTTP.
 *
 * Wraps CredentialVault (packages/service/src/vault.ts). Secrets are
 * encrypted with the vault master key; only references travel.
 *
 * Authorization: ref format `user:<userId>:<name>`. A requester may only
 * touch refs starting with their own `user:<userId>:` prefix (fail closed
 * otherwise). The vault itself is also constructed per request with a
 * request-scoped check closure, so the check callback and the HTTP handler
 * enforce the same rule (defense in depth). Persistence is in-memory for
 * now — prod backs this with the service metadata store backend.
 *
 * Endpoints:
 * - GET  /health
 * - POST /store    { ref, secret }
 * - POST /retrieve { ref } → { secret }
 * - POST /revoke   { ref }
 * - GET  /refs     → { refs: string[] } (requester's own refs only)
 */
import type { RequestListener } from 'node:http';
export declare function createVaultListener(): RequestListener;
