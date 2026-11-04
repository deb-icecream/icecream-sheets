/**
 * GCP OAuth2 access-token providers for Vertex AI calls from service
 * processes (used by the agent service's dictation route).
 *
 * Two sources, tried in order:
 * 1. A service-account key file (GOOGLE_APPLICATION_CREDENTIALS) — the
 *    local-dev path: the key's private key signs a JWT that is
 *    exchanged at the OAuth2 token endpoint (standard service-account
 *    flow; the key never leaves the process and is never logged).
 * 2. The GCE/Cloud Run metadata server — the deployed path, where the
 *    service runs under its attached service account.
 *
 * Both cache until shortly before expiry and fail SOFT (return null)
 * so callers can surface one clear "credentials not configured" error.
 */
type FetchImpl = typeof fetch;
/** Token provider backed by a service-account key file (JWT exchange). */
export declare function createServiceAccountTokenProvider(keyFilePath: string, fetchImpl?: FetchImpl): () => Promise<string | null>;
/** Token provider backed by the GCE/Cloud Run metadata server. */
export declare function createMetadataTokenProvider(fetchImpl?: FetchImpl): () => Promise<string | null>;
/**
 * The environment chain: service-account key file when
 * GOOGLE_APPLICATION_CREDENTIALS is set (local dev), else the metadata
 * server (deployed). Returns null when neither yields a token.
 */
export declare function createGcpAccessTokenProvider(env?: NodeJS.ProcessEnv, fetchImpl?: FetchImpl): () => Promise<string | null>;
export {};
