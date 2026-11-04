/**
 * API gateway: the single entry point in front of every icecream-sheets
 * service.
 *
 * - POST /auth/login  (LOCAL-DEV ONLY: accepts { userId }, issues a JWT.
 *   Gated behind GatewayOptions.devLoginEnabled (F-1, security pass):
 *   the route answers 404 unless a launcher explicitly opts in — the
 *   shipped bin wires it from ALLOW_DEV_LOGIN==='1', default OFF.
 *   Production identity is the real IdP (Firebase, below); NEVER accept
 *   arbitrary userIds in prod.)
 * - POST /auth/firebase  accepts { idToken } (a Firebase ID token from
 *   Google sign-in), verifies its RS256 signature against Google's certs
 *   (aud must equal the gateway's FIREBASE_PROJECT_ID), and issues a
 *   gateway JWT for the `user:<uid>` principal. 503 when Firebase is not
 *   configured on the gateway.
 * - GET /auth/me      verifies the Bearer token and returns its claims.
 * - /api/*            JWT-required reverse proxy to the backend services.
 *   The verified userId becomes the principal `user:<userId>`, forwarded
 *   as `x-principal` (and the original Authorization header is passed
 *   through too — EXCEPT on service-family routes, where it is replaced
 *   by a Google ID token for the upstream when one is available: the
 *   service Cloud Run service grants run.invoker only to the gateway's
 *   service account, so Cloud Run's platform layer consumes that
 *   Authorization slot; end-user identity still rides `x-principal`,
 *   which is what the services read). Rate-limited per principal →
 *   429 + Retry-After.
 *
 * The JWT carries identity ONLY (design-docs/permission-model.md §5) —
 * per-object permissions live in the services and are checked there.
 */

import http, { type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { issueToken, principalFromToken, verifyToken } from '@icecream-sheets/service';
import { verifyFirebaseIdToken } from './firebaseToken.js';
import {
  createMetadataIdTokenProvider,
  type ServiceIdTokenProvider,
} from './serviceIdToken.js';
import {
  applyCors,
  bearerToken,
  handlePreflight,
  readBody,
  sendError,
  sendJson,
  MAX_BODY_BYTES,
} from './httpUtils.js';
import { createRateLimiter, type RateLimiter } from './rateLimit.js';
import {
  AGENT_BINDING_HEADER,
  isSessionId,
  issueEngineAccessToken,
  issueStorageToken,
  newSessionId,
  selectEngineTier,
  signAgentBinding,
  STORAGE_TOKEN_TTL_SECONDS,
  type EngineAccessRole,
  type EngineTierUrls,
} from './deploy/engineAccess.js';
import {
  aclAllows,
  aclRoleFor,
  createFileRegistry,
  isLiveOwner,
  ownershipLeaseMs,
  type FileRegistry,
  type FileRegistryRecord,
} from './deploy/fileRegistry.js';
import {
  createUserDirectory,
  isDirectoryEmail,
  normalizeDirectoryEmail,
  type UserDirectory,
} from './deploy/userDirectory.js';
import {
  createUserFileCatalog,
  createUserSettingsStore,
  createUserTierStore,
  canonicalMimeForSourceFormat,
  defaultFileLimit,
  isThemeChoice,
  sourceFormatForFileName,
  tierLimits,
  type Tier,
  type UserFileCatalog,
  type UserFileRecord,
  type UserSettingsPatch,
  type UserSettingsStore,
  type UserTierStore,
} from './deploy/userStore.js';
import {
  maxOpenFilesPerUser as maxOpenFilesPerUserFromEnv,
  pickLru,
  userOpenSetFromStatuses,
  type UserOpenFileEntry,
} from './deploy/userOpenCap.js';
import {
  createUploadObjectStore,
  uploadObjectKey,
  verifyUploadToken,
  type UploadObjectStore,
} from './deploy/uploadStore.js';
import {
  createAppShareStore,
  shareSummary,
  type AppShareStore,
} from './deploy/shareStore.js';
import { validateAppSharePackage, type AppSharePackage } from '@icecream-sheets/service';
import {
  createBuiltAppStore,
  type BuiltAppRecord,
  type BuiltAppStore,
} from './deploy/builtAppStore.js';
import { engineAccessSecret } from './deploy/engineAccess.js';

/** Max request body for the engine file-upload endpoint (256MB). */
const LOAD_MAX_BODY_BYTES = 256 * 1024 * 1024;
/** Max request body for the engine download endpoint (32MB of session extras). */
const DOWNLOAD_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Default upstream proxy timeout (30s). */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
/**
 * Upstream timeout for ALL engine-service routes (10min) — Item D.
 *
 * The engine is the one stateful service, and legitimately long
 * operations are spread across its whole route surface, not just the
 * file endpoints: a workbook build (/load, /load/stream,
 * /load/storage-ref, /session/claim, /session/rehydrate — P99 build
 * ~249s per deployment-architecture.md), a checkpoint/save
 * (/session/release checkpoints + evicts; /download and
 * /library-save serialize or JOIN an in-flight checkpoint — P95 save
 * ~109s; a structural /ops or /execute first runs a barrier
 * checkpoint inside the sequencer and any op can queue behind an
 * in-flight save), and reads/deltas pended behind those operations.
 * Carving the long timeout out route-by-route kept drifting: /read,
 * /snapshot, /download and /library were each carved only after the
 * 30s default had already 502'd them in a gate, and /session/release,
 * /load/storage-ref, /session/rehydrate and /ops were still on the
 * 30s default (residual (o): a /download joining an in-flight P95
 * checkpoint, and the checkpoint-class calls around it, timed out at
 * the proxy while the engine completed correctly). Per the design
 * doc, proxied engine traffic is uniformly "600s-class" work, so the
 * whole '/api/engine' route gets this class; the gateway server's
 * requestTimeout (660s in bin/gateway.ts) already sits above it.
 * Stateless services keep the 30s fail-fast default (a hung one
 * should fail fast), and in signed mode the client bypasses this
 * proxy entirely (direct signed connection, engine-side 660s).
 */
export const ENGINE_UPSTREAM_TIMEOUT_MS = 600_000;
/**
 * Upstream timeout for POST /api/agent/message (~4.5min). An agent turn
 * can park on a human-in-the-loop ask for up to the agent service's
 * 4-minute HITL wait (agentSvc AGENT_HITL_TIMEOUT_MS, by design), so
 * the 30s default killed every parked turn at the proxy with a 502
 * (probe D4, reproduced 5×). 270s covers the 4-minute park plus the
 * turn's own tool work; the gateway server's requestTimeout (660s in
 * bin/gateway.ts) already sits above this class.
 */
export const AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS = 270_000;

export interface GatewayOptions {
  /** HMAC secret for the local-dev JWTs. */
  authSecret: string | Uint8Array;
  /** Route table: '/api/<name>' → backend base URL (e.g. 'http://127.0.0.1:8101'). */
  routes: Record<string, string>;
  /** Token-bucket config, applied per principal. */
  rateLimit: { points: number; perSeconds: number };
  /** JWT lifetime for /auth/login. Default 12h. */
  loginTtlSeconds?: number;
  /**
   * F-1 (security pass, Critical): POST /auth/login mints a gateway JWT
   * for ANY caller-named userId with NO credential check — full account
   * impersonation if served in production. The route is served ONLY
   * when this is explicitly true; default FALSE → the route answers
   * 404, indistinguishable from an unknown route. The shipped bin
   * (bin/gateway.ts) wires it from ALLOW_DEV_LOGIN==='1' (default OFF)
   * and warns loudly when on; local launchers opt in explicitly.
   */
  devLoginEnabled?: boolean;
  /**
   * Firebase project id (FIREBASE_PROJECT_ID). When set, POST
   * /auth/firebase exchanges verified Firebase ID tokens for gateway
   * JWTs. When unset, /auth/firebase returns 503.
   */
  firebaseProjectId?: string;
  /** Ring-buffer size for the request audit log. Default 500. */
  auditSize?: number;
  /**
   * Signed engine access (deployment-architecture.md §Engine access
   * pattern): when present, POST /api/engine/access issues short-lived
   * HMAC-signed engine tokens after the gateway's auth + rate limiting,
   * and the client connects DIRECTLY to the returned engine URL. When
   * absent the endpoint answers 501 and all engine traffic keeps using
   * the proxy routes (ENGINE_ACCESS_MODE=proxy, today's default).
   */
  engineAccess?: {
    /** Shared HMAC secret (ENGINE_ACCESS_SECRET; Secret Manager in prod). */
    secret: string;
    /** Token lifetime in seconds. Default 600 (10 min). */
    ttlSeconds?: number;
    /** Tier → direct engine base URL (ENGINE_URL_STANDARD / _XL). */
    tiers: EngineTierUrls;
  };
  /**
   * Storage download signing (save/download separation, 2026-10-21):
   * POST /api/storage/sign issues a short-lived HMAC token for one
   * library-store entry and returns a DIRECT engine-service URL — the
   * gateway signs, it never proxies the file bytes. `secret` is the
   * engine signing secret (ENGINE_ACCESS_SECRET; falls back to
   * engineAccess.secret). When no secret is configured the endpoint
   * answers 501 (fail closed — no unsigned fallback). `publicUrl` is
   * ENGINE_PUBLIC_URL: the engine service's directly-reachable origin;
   * when absent, the tier-standard engine URL, else the configured
   * '/api/engine' upstream origin, is used.
   */
  storageSign?: {
    secret?: string;
    publicUrl?: string;
    /** Token lifetime in seconds. Default 120. */
    ttlSeconds?: number;
  };
  /**
   * Combined service-package upstreams (SERVICE_COMBINED=on in
   * production; W19). When true, service-family routes
   * (SERVICE_FAMILY_ROUTE_PREFIXES: vault, meta, etl, agent, addons)
   * are proxied with the FULL path preserved — `/api/vault/store`
   * reaches the upstream as `/api/vault/store` — because the combined
   * runner (services/servicePackage.ts) dispatches on the
   * `/api/<name>` prefix; a stripped bare path would 404 there, and
   * bare-path dispatch inside the combined process would be ambiguous
   * anyway (etl and addons both serve a bare POST /run).
   *
   * When false/absent (the default — today's local per-bin topology,
   * where each bin serves bare paths), the matched route prefix is
   * stripped exactly as before, for every route. The flag never
   * affects non-service-family routes (e.g. /api/engine keeps the
   * strip behavior in both modes).
   */
  serviceCombined?: boolean;
  /**
   * Google ID-token provider for service-family upstreams (deploy
   * follow-up Leg 1; see serviceIdToken.ts). The combined
   * service-package Cloud Run service grants `roles/run.invoker` ONLY
   * to the gateway's service account, so Cloud Run's platform layer
   * rejects any proxied request whose `Authorization` is not a Google
   * ID token with audience = the service's URL — the gateway JWT in
   * that slot earned a platform 401 and the service never ran.
   *
   * When the provider yields a token for a service-family upstream
   * (SERVICE_FAMILY_ROUTE_PREFIXES, still on its CONFIGURED backend —
   * never an automation owner-route to an engine), the proxy sends
   * `Authorization: Bearer <id-token>` INSTEAD of the caller's gateway
   * JWT. End-user identity is NOT lost: it rides `x-principal`
   * (gateway-verified, set by the proxy on every request), which is
   * the header every service surface reads; the one consumer of the
   * forwarded Authorization, the add-on /run binding resolver,
   * ignores the gateway JWT in production wiring and mints its own
   * engine-access token (addonEngineBinding.ts, FIX-R3).
   *
   * Default: createMetadataIdTokenProvider() (Cloud Run metadata
   * server). It fails soft — no metadata server (local dev) → null →
   * the request is proxied exactly as before, gateway JWT and all.
   * Engine upstreams NEVER get an ID token: engines are reached via
   * the signed-URL direct flow and verify their own tokens.
   */
  serviceIdTokenProvider?: ServiceIdTokenProvider;
  /**
   * Phase 2 session ownership registry (design doc §9) for
   * POST /api/engine/open. Default: createFileRegistry(process.env)
   * (local FS adapter under FILE_REGISTRY_DIR; prod construction
   * failures are remembered and surface as 503 fail-closed at open
   * time, never as a silently-local registry).
   */
  fileRegistry?: FileRegistry;
  /**
   * Phase 2 engine instance map (ENGINE_INSTANCES env, instanceId →
   * baseUrl) used to pick the claim target on a first open. Default:
   * the single configured tier URL under ENGINE_INSTANCE_ID
   * (default 'engine-1').
   */
  engineInstances?: Record<string, string>;
  /**
   * XL-tier engine instance map (ENGINE_INSTANCES_XL env, same shape).
   * Used for xl-tier claims when non-empty; otherwise the shared
   * engineInstances pool serves both tiers (placement fix, 2026-10-23).
   */
  engineInstancesXl?: Record<string, string>;
  /** This deployment's preferred engine instance id (claim target). */
  engineInstanceId?: string;
  /**
   * Per-user simultaneous-open cap (design doc §9A;
   * MAX_OPEN_FILES_PER_USER env): the maximum number of DISTINCT
   * files one principal may hold open at once across all their
   * client instances. Opening one more silently evicts the user from
   * their least recently used open file. Default: the env value,
   * else 4.
   */
  maxOpenFilesPerUser?: number;
  /** Ownership lease TTL for claims (OWNERSHIP_LEASE_MS). */
  ownershipLeaseMs?: number;
  /**
   * Product layer (CONTRACT.md §Tiers/§File catalog/§Upload object
   * store): per-user tier store. Default: createUserTierStore(
   * process.env) (local adapter under USER_STORE_DIR). A prod-mode
   * construction failure is remembered and makes the product
   * endpoints fail closed (503); other routes are unaffected.
   */
  userTierStore?: UserTierStore;
  /** Product layer: per-user file catalog. Same defaulting posture. */
  userFileCatalog?: UserFileCatalog;
  /** Invite-by-email directory (issue #84a). Same defaulting posture. */
  userDirectory?: UserDirectory;
  /** Product layer: upload object store. Same defaulting posture. */
  uploadStore?: UploadObjectStore;
  /**
   * HMAC secret for upload staging tokens (the ENGINE_ACCESS_SECRET
   * storage-sign secret path). Default: storageSign/engineAccess
   * secret, else ENGINE_ACCESS_SECRET env, else the gateway auth
   * secret (local-dev fallback so staging works out of the box).
   */
  uploadTokenSecret?: string;
  /**
   * Public base URL the upload staging URLs are built on
   * (GATEWAY_PUBLIC_URL; the bin sets it from the listen port).
   * Synced onto the upload store when provided.
   */
  uploadPublicBaseUrl?: string;
  /**
   * App-gallery share store (app + data snapshot shares). Default:
   * createAppShareStore(process.env) (local adapter). A prod-mode
   * construction failure makes /api/shares fail closed (503); other
   * routes are unaffected.
   */
  appShareStore?: AppShareStore;
  /**
   * Workspace settings store (per-user profile + Icecream Office app
   * settings; hidden_files/workspace-settings/BRIEF.md). Default:
   * createUserSettingsStore(process.env) (local adapter under
   * USER_STORE_DIR). A prod-mode construction failure makes
   * /api/settings + DELETE /api/account fail closed (503); other
   * routes are unaffected.
   */
  userSettingsStore?: UserSettingsStore;
  /**
   * W4 built-app store (UI-built AppSpecs, keyed by owner + file).
   * Default: createBuiltAppStore(process.env) (local adapter under
   * BUILT_APP_STORE_DIR / the session data dir). A prod-mode
   * construction failure makes /api/built-apps fail closed (503);
   * other routes are unaffected.
   */
  builtAppStore?: BuiltAppStore;
}

/** Parse the ENGINE_INSTANCES env JSON map (instanceId → baseUrl). */
export function parseEngineInstances(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() !== '') out[k] = v.replace(/\/+$/, '');
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The service-family route prefixes served by the combined
 * service-package runner in production (vault, meta, etl, agent,
 * addons). `/api/addons` is a service-family route like the other
 * four — it is the addons bin's surface, not an engine route.
 */
export const SERVICE_FAMILY_ROUTE_PREFIXES = [
  '/api/vault',
  '/api/meta',
  '/api/etl',
  '/api/agent',
  '/api/addons',
  '/api/connectors',
  '/api/automation',
] as const;

const SERVICE_FAMILY_ROUTE_SET: ReadonlySet<string> = new Set(SERVICE_FAMILY_ROUTE_PREFIXES);

/**
 * SERVICE_COMBINED env parsing for the gateway bin: 'on' (the value
 * deploy/services/gateway.yaml sets), 'true' and '1' also enable it;
 * anything else (including unset) is OFF, so the default local
 * per-bin topology keeps its byte-identical strip behavior.
 */
export function serviceCombinedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['on', 'true', '1'].includes((env.SERVICE_COMBINED ?? '').trim().toLowerCase());
}

export interface AuditEntry {
  ts: string;
  method: string;
  path: string;
  principal: string;
  status: number;
  durationMs: number;
}

export interface GatewayListener extends RequestListener {
  /** In-memory request audit log (ring buffer, newest last). For tests. */
  auditLog: AuditEntry[];
  /** The rate limiter (for tests / status). */
  limiter: RateLimiter;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function createGateway(opts: GatewayOptions): GatewayListener {
  const { authSecret, routes } = opts;
  const loginTtlSeconds = opts.loginTtlSeconds ?? 12 * 3600;
  const devLoginEnabled = opts.devLoginEnabled ?? false;
  const auditSize = opts.auditSize ?? 500;
  const limiter = createRateLimiter(opts.rateLimit);
  const audit: AuditEntry[] = [];
  // Service-family Cloud Run identity (Leg 1): resolved once; the
  // default metadata provider fails soft to null off-GCP, so local
  // topologies proxy byte-identically to before.
  const serviceIdTokenProvider: ServiceIdTokenProvider =
    opts.serviceIdTokenProvider ?? createMetadataIdTokenProvider();

  // Phase 2 ownership registry (§9): resolved once. A prod-mode
  // construction failure is NOT fatal to the gateway process (other
  // routes keep working) but makes /api/engine/open fail closed 503.
  let fileRegistry: FileRegistry | null = opts.fileRegistry ?? null;
  if (!fileRegistry) {
    try {
      fileRegistry = createFileRegistry(process.env);
    } catch (e) {
      console.error(
        `[gateway] file registry unavailable: ${e instanceof Error ? e.message : String(e)} — /api/engine/open will fail closed (503)`,
      );
      fileRegistry = null;
    }
  }
  const engineInstances: Record<string, string> =
    opts.engineInstances ?? parseEngineInstances(process.env.ENGINE_INSTANCES);
  // Placement fix (2026-10-23): the XL tier may carry its OWN fleet
  // (ENGINE_INSTANCES_XL, same JSON shape). An empty XL map falls back
  // to the shared ENGINE_INSTANCES pool, then to the single tier URL.
  const engineInstancesXl: Record<string, string> =
    opts.engineInstancesXl ?? parseEngineInstances(process.env.ENGINE_INSTANCES_XL);
  const engineInstanceId =
    (opts.engineInstanceId ?? (process.env.ENGINE_INSTANCE_ID ?? '').trim()) || 'engine-1';
  // Per-user open cap (§9A): opts override, else MAX_OPEN_FILES_PER_USER.
  const openFileCap = opts.maxOpenFilesPerUser ?? maxOpenFilesPerUserFromEnv(process.env);
  // Interim fleet-5 rule (spec §2.2, 2026-10-24): claim candidates are
  // tried in ROTATION order — each successful claim advances the cursor
  // past the chosen service, so new files spread across the fleet
  // instead of always piling onto the home instance. The cursor is an
  // ordering preference only: every claim still tries all candidates,
  // skipping busy ones, so correctness never depends on it.
  let claimRotationCursor = 0;

  // Product layer stores (CONTRACT.md): resolved once. A prod-mode
  // construction failure is NOT fatal to the gateway process (other
  // routes keep working) but makes the product endpoints that need
  // the missing store fail closed (503) — the fileRegistry posture.
  const uploadTokenSecret: string =
    opts.uploadTokenSecret ??
    opts.storageSign?.secret ??
    opts.engineAccess?.secret ??
    engineAccessSecret(process.env) ??
    (typeof authSecret === 'string' ? authSecret : Buffer.from(authSecret as Uint8Array).toString('utf8'));
  let userTierStore: UserTierStore | null = opts.userTierStore ?? null;
  if (!userTierStore) {
    try {
      userTierStore = createUserTierStore(process.env);
    } catch (e) {
      console.error(
        `[gateway] user tier store unavailable: ${e instanceof Error ? e.message : String(e)} — product endpoints will fail closed (503)`,
      );
      userTierStore = null;
    }
  }
  let userFileCatalog: UserFileCatalog | null = opts.userFileCatalog ?? null;
  if (!userFileCatalog) {
    try {
      userFileCatalog = createUserFileCatalog(process.env);
    } catch (e) {
      console.error(
        `[gateway] user file catalog unavailable: ${e instanceof Error ? e.message : String(e)} — product endpoints will fail closed (503)`,
      );
      userFileCatalog = null;
    }
  }
  let userDirectory: UserDirectory | null = opts.userDirectory ?? null;
  if (!userDirectory) {
    try {
      userDirectory = createUserDirectory(process.env);
    } catch (e) {
      console.error(
        `[gateway] user directory unavailable: ${e instanceof Error ? e.message : String(e)} — invite-by-email will fail closed (503)`,
      );
      userDirectory = null;
    }
  }
  let uploadStore: UploadObjectStore | null = opts.uploadStore ?? null;
  if (!uploadStore) {
    try {
      uploadStore = createUploadObjectStore(process.env, {
        tokenSecret: uploadTokenSecret,
        ...(opts.uploadPublicBaseUrl ? { publicBaseUrl: opts.uploadPublicBaseUrl } : {}),
      });
    } catch (e) {
      console.error(
        `[gateway] upload object store unavailable: ${e instanceof Error ? e.message : String(e)} — product endpoints will fail closed (503)`,
      );
      uploadStore = null;
    }
  } else {
    // Align an injected store with the gateway's staging config when
    // the caller supplied it (the bin/tests set port + secret after
    // construction): the staging URLs the store mints must verify at
    // THIS gateway.
    if (opts.uploadPublicBaseUrl) uploadStore.publicBaseUrl = opts.uploadPublicBaseUrl;
    if (opts.uploadTokenSecret) uploadStore.tokenSecret = opts.uploadTokenSecret;
  }
  let appShareStore: AppShareStore | null = opts.appShareStore ?? null;
  if (!appShareStore) {
    try {
      appShareStore = createAppShareStore(process.env);
    } catch (e) {
      console.error(
        `[gateway] app share store unavailable: ${e instanceof Error ? e.message : String(e)} — /api/shares will fail closed (503)`,
      );
      appShareStore = null;
    }
  }
  let userSettingsStore: UserSettingsStore | null = opts.userSettingsStore ?? null;
  if (!userSettingsStore) {
    try {
      userSettingsStore = createUserSettingsStore(process.env);
    } catch (e) {
      console.error(
        `[gateway] user settings store unavailable: ${e instanceof Error ? e.message : String(e)} — /api/settings will fail closed (503)`,
      );
      userSettingsStore = null;
    }
  }
  let builtAppStore: BuiltAppStore | null = opts.builtAppStore ?? null;
  if (!builtAppStore) {
    try {
      builtAppStore = createBuiltAppStore(process.env);
    } catch (e) {
      console.error(
        `[gateway] built-app store unavailable: ${e instanceof Error ? e.message : String(e)} — /api/built-apps will fail closed (503)`,
      );
      builtAppStore = null;
    }
  }

  /**
   * Tier for an auth exchange: the tier-store record is the source of
   * truth at each login. Auth itself never fails on a tier-store
   * problem — an unavailable/erroring store stamps 'default' and the
   * product endpoints surface the 503.
   */
  async function resolveTierFor(userId: string, email?: string): Promise<Tier> {
    if (!userTierStore) return 'default';
    try {
      return await userTierStore.resolveTier({ userId, ...(email ? { email } : {}) });
    } catch {
      return 'default';
    }
  }

  /**
   * Tier for an already-authenticated principal (user:<userId>).
   * NON-CREATING read: resolveTier is get-or-create (a login-exchange
   * operation), and using it here made every /api/files request
   * resurrect a tier record that DELETE /api/account had removed —
   * any still-valid token + one files request re-created a 'default'
   * record for a deleted user. The record is created at the auth
   * exchange; enforcement only reads it (live, so mid-session
   * promotions still apply), defaulting to 'default' when absent.
   */
  async function tierForPrincipal(principal: string): Promise<Tier> {
    const userId = principal.startsWith('user:') ? principal.slice('user:'.length) : principal;
    if (!userTierStore) return 'default';
    try {
      const rec = await userTierStore.getRecord(userId);
      return rec?.tier ?? 'default';
    } catch {
      return 'default';
    }
  }

  /**
   * Verify a staging token against the gateway's secret, falling back
   * to the upload store's own secret when it differs (an injected
   * store may have been constructed with its minting secret before
   * the gateway's was known — the token IS the auth either way, and
   * both secrets are gateway-side configuration).
   */
  function verifyStagingToken(
    token: string,
    verifyOpts: { op: 'put' | 'get'; object: string },
  ): ReturnType<typeof verifyUploadToken> {
    try {
      return verifyUploadToken(token, uploadTokenSecret, verifyOpts);
    } catch (e) {
      const storeSecret = uploadStore?.tokenSecret;
      if (storeSecret && storeSecret !== uploadTokenSecret) {
        return verifyUploadToken(token, storeSecret, verifyOpts);
      }
      throw e;
    }
  }

  function logAudit(method: string, path: string, principal: string, status: number, durationMs: number): void {
    audit.push({ ts: new Date().toISOString(), method, path, principal, status, durationMs });
    if (audit.length > auditSize) audit.splice(0, audit.length - auditSize);
    // One line per request: cheap, greppable, no PII beyond the principal id.
    console.log(`[gateway] ${method} ${path} principal=${principal} status=${status} ${durationMs}ms`);
  }

  /**
   * #108: resolve a gateway-attached signed binding for an
   * agent-service call naming a file. The gateway is the ONLY
   * registry reader for agent binding: it resolves live owner +
   * role + liveness here, signs, and attaches; the service verifies
   * and uses the endpoint it was given. Outcomes:
   * - 'bound': attach the signed binding to the proxied call.
   * - 'unbound': proxy WITHOUT a binding — the service answers the
   *   honest unbound message (no live session, no endpoint, or no
   *   signing secret; a live response naming another session is
   *   unbound too, never a wrong-engine call).
   * - 'error': fail fast with code/message — a registry failure or
   *   a dead engine must never be proxied as "unbound" (that would
   *   be a lie about a file that may be open), and a principal with
   *   no grant is refused BEFORE the service is contacted (the
   *   agent's primary gate).
   */
  type AgentBindingResolution =
    | { status: 'bound'; binding: string }
    | { status: 'unbound' }
    | { status: 'error'; code: number; message: string };
  const resolveAgentBinding = async (
    principal: string,
    fileId: string,
  ): Promise<AgentBindingResolution> => {
    if (!fileRegistry) return { status: 'unbound' };
    let rec: FileRegistryRecord | null;
    try {
      rec = await fileRegistry.lookup(fileId);
    } catch {
      return { status: 'error', code: 503, message: 'session registry unavailable' };
    }
    if (!rec || !isLiveOwner(rec)) return { status: 'unbound' };
    const endpoint = (rec.ownerEndpoint ?? '').trim();
    if (endpoint.length === 0) return { status: 'unbound' };
    // Primary gate: no owner-recorded grant → refuse BEFORE the
    // service is contacted. Role mapping matches roleForPrincipal
    // (agentSessionResolver): owner/editor → editor, viewer → viewer.
    const acl = aclRoleFor(rec, principal);
    if (!acl) return { status: 'error', code: 403, message: 'no access grant for this file' };
    const role = acl === 'viewer' ? 'viewer' : 'editor';
    const secret = opts.engineAccess?.secret ?? engineAccessSecret(process.env);
    if (!secret) return { status: 'unbound' };
    // Liveness (#100 rule, same probe as JOIN): a record can outlive
    // its engine copy while the lease is warm — never attach a
    // binding to a dead/wrong engine. Unreachable or non-200 →
    // 503 (transient or dead: honest, retryable); a live response
    // naming another session or a non-active status → unbound
    // (stale record; never a wrong-engine call). Tier is not
    // enforced on /session/status — 'standard' is a well-formed
    // placeholder (the fleet-5 pool is all standard).
    let ownerLive: boolean | null = null;
    try {
      const probeRes = await fetch(`${endpoint.replace(/\/+$/, '')}/session/status`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${issueEngineAccessToken({
            secret,
            principal,
            sessionId: rec.sessionId,
            tier: 'standard',
            fid: fileId,
            role: 'viewer',
            ttlSeconds: 120,
          }).token}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (probeRes.ok) {
        const probe = (await probeRes.json()) as { status?: unknown; sessionId?: unknown };
        ownerLive = probe.status === 'active' && probe.sessionId === rec.sessionId;
      } else {
        ownerLive = null;
      }
    } catch {
      ownerLive = null;
    }
    if (ownerLive === null) {
      return { status: 'error', code: 503, message: 'engine unavailable' };
    }
    if (!ownerLive) return { status: 'unbound' };
    const { binding } = signAgentBinding({
      secret,
      principal,
      fileId,
      sessionId: rec.sessionId,
      role,
      endpoint,
      epoch: rec.ownershipEpoch,
      rev: typeof rec.currentRevision === 'number' ? rec.currentRevision : 0,
    });
    return { status: 'bound', binding };
  };

  const handle: RequestListener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    if (handlePreflight(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://gateway');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    const finish = (principal: string, status: number): void => {
      logAudit(method, path, principal, status, Date.now() - started);
    };
    const reply = (principal: string, status: number, obj: unknown): void => {
      finish(principal, status);
      sendJson(res, status, obj);
    };
    const fail = (principal: string, status: number, error: string): void => {
      finish(principal, status);
      sendError(res, status, error);
    };
    const failExtra = (
      principal: string,
      status: number,
      error: string,
      extra: Record<string, unknown>,
    ): void => {
      finish(principal, status);
      sendError(res, status, error, extra);
    };

    try {
      // -- auth endpoints -------------------------------------------------
      if (path === '/auth/login' && method === 'POST') {
        // ================================================================
        // LOCAL-DEV ONLY, OPT-IN (F-1, security pass). This endpoint
        // mints a signed JWT for ANY userId the caller names — no
        // credential check. Unless the launcher explicitly enabled it
        // (GatewayOptions.devLoginEnabled; the shipped bin reads
        // ALLOW_DEV_LOGIN==='1', default OFF), the route does not exist:
        // 404, exactly like an unknown route. Production identity is
        // Firebase Auth (/auth/firebase below).
        // ================================================================
        if (!devLoginEnabled) {
          return fail('anonymous', 404, `not found: ${path}`);
        }
        // Rate-limit login attempts per client IP (brute-force protection).
        const clientIp = req.socket?.remoteAddress ?? 'unknown';
        const rlLogin = limiter.take(`login:${clientIp}`);
        if (!rlLogin.allowed) {
          applyCors(res);
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rlLogin.retryAfterMs / 1000))));
          return fail('anonymous', 429, 'rate limit exceeded');
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail('anonymous', 400, bodyError(e));
        }
        const userId = (body as { userId?: unknown } | undefined)?.userId;
        if (typeof userId !== 'string' || userId.length === 0 || /[:\s]/.test(userId)) {
          return fail('anonymous', 400, 'userId must be a non-empty string without spaces or colons');
        }
        // Product layer: stamp the user's tier (tier-store record is
        // the source of truth at each login) into the JWT + response.
        const tier = await resolveTierFor(userId);
        const token = await issueToken({
          userId,
          attrs: { tier },
          secret: authSecret,
          ttlSeconds: loginTtlSeconds,
        });
        return reply(`user:${userId}`, 200, { ok: true, token, userId, tier, expiresIn: loginTtlSeconds });
      }

      if (path === '/auth/firebase' && method === 'POST') {
        // Firebase Google sign-in exchange (Cycle 9). The gateway verifies
        // the Firebase ID token's RS256 signature itself — the client is
        // never trusted to name its own identity — then mints a gateway JWT
        // for the user:<uid> principal, exactly like /auth/login.
        const rlFirebase = limiter.take(`firebase-login:${req.socket?.remoteAddress ?? 'unknown'}`);
        if (!rlFirebase.allowed) {
          applyCors(res);
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rlFirebase.retryAfterMs / 1000))));
          return fail('anonymous', 429, 'rate limit exceeded');
        }
        const firebaseProjectId = opts.firebaseProjectId;
        if (!firebaseProjectId) {
          return fail(
            'anonymous',
            503,
            'firebase auth is not configured on this gateway (set FIREBASE_PROJECT_ID)',
          );
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail('anonymous', 400, bodyError(e));
        }
        const idToken = (body as { idToken?: unknown } | undefined)?.idToken;
        if (typeof idToken !== 'string' || idToken.length === 0) {
          return fail('anonymous', 400, 'idToken must be a non-empty string');
        }
        let fb: { uid: string; email?: string; name?: string };
        try {
          fb = await verifyFirebaseIdToken(idToken, { projectId: firebaseProjectId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail('anonymous', 401, `invalid firebase id token: ${msg}`);
        }
        const userId = fb.uid;
        if (/[:\s]/.test(userId)) {
          return fail('anonymous', 401, 'invalid firebase id token: subject not usable as principal');
        }
        // Identity only (permission-model.md §5): coarse slow-changing
        // profile attrs, never per-object permissions. Product layer:
        // the tier joins them — stamped from the tier-store record
        // (a pending promotion for this email is consumed here, at
        // the record's first creation).
        const tier = await resolveTierFor(userId, fb.email);
        // Issue #84a: fill the invite-by-email directory from this
        // sign-in. Best-effort — a directory write failure must never
        // fail a login (the lookup endpoint fails closed on its own).
        if (userDirectory && fb.email) {
          await userDirectory.recordSignIn(userId, fb.email, fb.name).catch(() => undefined);
        }
        const attrs: Record<string, string> = { tier };
        if (fb.name) attrs['name'] = fb.name;
        if (fb.email) attrs['email'] = fb.email;
        const token = await issueToken({ userId, attrs, secret: authSecret, ttlSeconds: loginTtlSeconds });
        return reply(`user:${userId}`, 200, { ok: true, token, userId, tier, expiresIn: loginTtlSeconds });
      }

      if (path === '/auth/me' && method === 'GET') {
        const token = bearerToken(req);
        if (!token) return fail('anonymous', 401, 'missing Authorization: Bearer token');
        try {
          const claims = await verifyToken(token, authSecret);
          const principal = principalFromToken(claims);
          return reply(principal, 200, {
            ok: true,
            userId: claims.userId,
            attrs: claims.attrs,
            iat: claims.iat,
            exp: claims.exp,
            principal,
          });
        } catch {
          return fail('anonymous', 401, 'invalid or expired token');
        }
      }

      if (path === '/auth/__audit' && method === 'GET') {
        return reply('anonymous', 200, { ok: true, entries: [...audit] });
      }

      if (path === '/health' && method === 'GET') {
        return reply('anonymous', 200, { ok: true, service: 'gateway', routes: Object.keys(routes) });
      }

      // -- upload staging (product layer): the upload TOKEN is the auth
      //    (CONTRACT §Upload object store). These routes sit beside the
      //    /auth/* handling, BEFORE the /api JWT pipeline: a client
      //    PUTs/GETs file bytes directly against the signed staging
      //    URL the gateway issued — no gateway JWT is involved.
      if (path.startsWith('/uploads/stage/')) {
        if (!uploadStore) {
          return fail('anonymous', 503, 'upload store unavailable');
        }
        let object: string;
        try {
          object = decodeURIComponent(path.slice('/uploads/stage/'.length));
        } catch {
          return fail('anonymous', 400, 'malformed staged object name');
        }
        if (object.length === 0) return fail('anonymous', 400, 'missing staged object name');
        const ut = url.searchParams.get('ut');
        if (!ut) return fail('anonymous', 401, 'missing upload token');
        if (method === 'PUT') {
          let claims: ReturnType<typeof verifyUploadToken>;
          try {
            claims = verifyStagingToken(ut, { op: 'put', object });
          } catch {
            return fail('anonymous', 401, 'invalid or expired upload token');
          }
          const maxBytes = claims.maxBytes ?? 256 * 1024 * 1024;
          const chunks: Buffer[] = [];
          let total = 0;
          let tooLarge = false;
          try {
            for await (const chunk of req) {
              const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
              total += buf.length;
              if (total > maxBytes) {
                tooLarge = true;
                break;
              }
              chunks.push(buf);
            }
          } catch {
            return fail(claims.principal, 400, 'failed to read upload body');
          }
          if (tooLarge) {
            // Abort past the token's maxBytes: drop anything staged
            // for this object (no partial survives) and refuse.
            req.resume();
            await uploadStore.delete(object).catch(() => undefined);
            return failExtra(claims.principal, 413, `upload exceeds the ${maxBytes}-byte limit for this grant`, {
              code: 'UPLOAD_TOO_LARGE',
              limit: maxBytes,
              tier: 'default',
            });
          }
          await uploadStore.put(object, Buffer.concat(chunks));
          return reply(claims.principal, 200, { ok: true, object, size: total });
        }
        if (method === 'GET') {
          let claims: ReturnType<typeof verifyUploadToken>;
          try {
            claims = verifyStagingToken(ut, { op: 'get', object });
          } catch {
            return fail('anonymous', 401, 'invalid or expired upload token');
          }
          const bytes = await uploadStore.get(object);
          if (!bytes) return fail(claims.principal, 404, 'staged object not found');
          finish(claims.principal, 200);
          applyCors(res);
          const baseName = object.split('/').pop() ?? 'download.xlsx';
          res.writeHead(200, {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'Content-Disposition': `attachment; filename="${baseName.replace(/"/g, '')}"`,
            'Content-Length': bytes.length,
          });
          res.end(bytes);
          return;
        }
        return fail('anonymous', 404, `not found: ${path}`);
      }

      // -- /api/* : authenticated, rate-limited reverse proxy -------------
      if (!path.startsWith('/api/')) {
        return fail('anonymous', 404, `not found: ${path}`);
      }

      // Auth first (fail closed): every /api/* request needs a Bearer JWT.
      const token = bearerToken(req);
      if (!token) {
        applyCors(res);
        return fail('anonymous', 401, 'missing Authorization: Bearer token');
      }
      let principal: string;
      // Verified token attrs (identity only: tier + the provider's
      // name/email stamped at the exchange). /api/settings echoes the
      // provider name/email from HERE — never from the request — so a
      // client cannot spoof its own profile defaults.
      let callerAttrs: Record<string, string> = {};
      try {
        const claims = await verifyToken(token, authSecret);
        callerAttrs = claims.attrs ?? {};
        principal = principalFromToken(claims);
      } catch {
        applyCors(res);
        return fail('anonymous', 401, 'invalid or expired token');
      }

      // Rate limit per principal.
      const rl = limiter.take(principal);
      if (!rl.allowed) {
        applyCors(res);
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))));
        return fail(principal, 429, 'rate limit exceeded');
      }

      // -- signed engine access issuance (deployment doc: stateful
      //    engine ONLY; stateless services stay on the proxied path) ---
      // Auth + rate limiting above have already run — issuance IS the
      // gateway's handshake. The client names the session it wants the
      // token scoped to (or gets a fresh one minted) and, when it knows
      // it, the workbook's cell count for tier selection.
      if (path === '/api/engine/access' && method === 'POST') {
        if (!opts.engineAccess) {
          return fail(
            principal,
            501,
            'signed engine access is not enabled on this gateway (ENGINE_ACCESS_MODE is not signed)',
          );
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(principal, 400, bodyError(e));
        }
        const b = (body ?? {}) as { sessionId?: unknown; cellCount?: unknown };
        if (b.sessionId !== undefined && !isSessionId(b.sessionId)) {
          return fail(principal, 400, 'sessionId must match [A-Za-z0-9._:-]{1,128}');
        }
        const sessionId = isSessionId(b.sessionId) ? b.sessionId : newSessionId();
        const cellCount =
          typeof b.cellCount === 'number' && Number.isFinite(b.cellCount) && b.cellCount >= 0
            ? Math.floor(b.cellCount)
            : undefined;
        const tier = selectEngineTier(cellCount);
        const ttlSeconds = opts.engineAccess.ttlSeconds ?? 600;
        const { token, claims } = issueEngineAccessToken({
          secret: opts.engineAccess.secret,
          principal,
          sessionId,
          tier,
          ttlSeconds,
        });
        return reply(principal, 200, {
          ok: true,
          accessToken: token,
          engineUrl: opts.engineAccess.tiers[tier],
          sessionId,
          tier,
          expiresAt: claims.exp * 1000,
          expiresInSeconds: ttlSeconds,
        });
      }

      // -- Phase 2 join handshake (design doc §9) ----------------------
      // POST /api/engine/open: the client asks the GATEWAY to open a
      // file (JWT auth + per-principal rate limit have already run
      // above). The gateway reads the session ownership registry:
      //   * live owner → JOIN that session on that instance;
      //   * no record / expired lease → CLAIM: pick an engine
      //     instance, ask it to create-or-rehydrate the session for
      //     this fileId (POST {engine}/session/claim), then CAS-claim
      //     the registry record (epoch = previous+1, or 1). A CAS
      //     loser re-reads and JOINs the winner.
      //   * registry read/write throws → 503 FAIL-CLOSED, no session
      //     created anywhere.
      // The response shape is IDENTICAL for join vs create; it carries
      // connection information ONLY (endpoint, sessionId, a signed
      // token scoped { sub, sid, fid, role, exp }, current revision).
      if (path === '/api/engine/open' && method === 'POST') {
        if (!opts.engineAccess) {
          return fail(
            principal,
            501,
            'signed engine access is not enabled on this gateway (ENGINE_ACCESS_MODE is not signed)',
          );
        }
        if (!fileRegistry) {
          return fail(principal, 503, 'session registry unavailable');
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(principal, 400, bodyError(e));
        }
        const b = (body ?? {}) as {
          fileId?: unknown;
          name?: unknown;
          role?: unknown;
          cellCount?: unknown;
          clientInstanceId?: unknown;
        };
        if (b.role !== undefined && b.role !== 'editor' && b.role !== 'viewer') {
          return fail(principal, 400, "role must be 'editor' or 'viewer'");
        }
        const requestedRole = (b.role as EngineAccessRole | undefined) ?? 'editor';
        // Issue #51 (read-only enforcement; design doc section 4,
        // owner ruling 2026-10-23 01:10 PDT): access to a file comes
        // ONLY from a grant. The role minted for a NON-CREATOR is the
        // owner-recorded grant (POST /api/engine/share) and nothing
        // else: no grant -> null -> the open is DENIED outright (the
        // file cannot even be opened — join path AND claim/rehydrate
        // path alike). The requested role can only LOWER a grant (an
        // editor-grantee may open as viewer), never raise it. A null
        // record means the caller is creating a new file and is its
        // creator. Before this fix, the body's role was minted
        // verbatim — any signed-in user who knew a fileId received an
        // editor token by default and could write through every path.
        const effectiveRoleFor = (
          r: FileRegistryRecord | null,
          p: string,
        ): EngineAccessRole | null => {
          // Section 8: the access verdict itself belongs to the
          // file-owning layer (aclRoleFor, deploy/fileRegistry.ts).
          // This adapter only maps the verdict onto an engine-token
          // role and applies the request-can-only-lower shaping.
          const acl = aclRoleFor(r, p);
          if (!acl) return null;
          if (acl === 'viewer' || requestedRole === 'viewer') return 'viewer';
          return 'editor';
        };
        let fileId: string;
        if (b.fileId !== undefined) {
          if (typeof b.fileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.fileId)) {
            return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
          }
          fileId = b.fileId;
        } else {
          fileId = `file-${randomUUID()}`;
        }
        // Registry record first: the catalog ownership check below is
        // grant-aware (issue #51, design doc section 4) — a non-owner
        // WITH an owner-recorded grant proceeds to role resolution;
        // without one the catalog guard answers as before.
        let rec: Awaited<ReturnType<FileRegistry['lookup']>>;
        try {
          rec = await fileRegistry.lookup(fileId);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        // Product layer catalog ownership (CONTRACT §Gateway
        // endpoints): a catalogued file opens ONLY for its owner —
        // anyone else gets the same 404 as a nonexistent file (no
        // existence leak). Issue #51 exception: a principal holding an
        // owner-recorded grant on the file proceeds (their role is
        // resolved from the grant below); recents (touchOpened) remain
        // the owner's alone. No catalog record → the registry decides.
        if (userFileCatalog) {
          try {
            const catRec = await userFileCatalog.get(fileId);
            if (catRec) {
              if (catRec.ownerPrincipal !== principal) {
                // A grant exists only on a REGISTRY record — with no
                // record there is nothing to grant against, and the
                // aclRoleFor(null) "creator of a new file" case must
                // never admit anyone to a catalogued file.
                if (!rec || !aclRoleFor(rec, principal)) {
                  return fail(principal, 404, 'file not found');
                }
              } else {
                await userFileCatalog.touchOpened(fileId).catch(() => undefined);
              }
            }
          } catch {
            // Catalog read problems never block an open (the registry
            // below remains the fail-closed authority for ownership
            // of the live session itself).
          }
        }
        const cellCount =
          typeof b.cellCount === 'number' && Number.isFinite(b.cellCount) && b.cellCount >= 0
            ? Math.floor(b.cellCount)
            : undefined;
        const tier = selectEngineTier(cellCount);
        const ttlSeconds = opts.engineAccess.ttlSeconds ?? 600;
        const issueFor = (sessionId: string, role: EngineAccessRole): string =>
          issueEngineAccessToken({
            secret: opts.engineAccess!.secret,
            principal,
            sessionId,
            tier,
            fid: fileId,
            role,
            ttlSeconds,
          }).token;
        // #106: a token acting on ANOTHER file's session must name THAT
        // file. issueFor binds fid to this open's target file, which is
        // exactly wrong for a cap eviction: the detach token for the
        // LRU session must carry the LRU file's fid, or the engine's
        // #104 file-scope rule (rightly) refuses it 401 wrong-file —
        // which silently disabled every cap eviction. Every other
        // issueFor call site acts on this open's own session, so only
        // the detach-user call uses this helper.
        const issueForFile = (
          sessionId: string,
          fileIdForToken: string,
          role: EngineAccessRole,
        ): string =>
          issueEngineAccessToken({
            secret: opts.engineAccess!.secret,
            principal,
            sessionId,
            tier,
            fid: fileIdForToken,
            role,
            ttlSeconds,
          }).token;
        // Fleet eviction token (spec §2.3): carries the gateway's
        // fleet-management authority for exactly one session+file.
        // The engine honors it on /session/release ONLY (single-
        // purpose guard in the engine preamble) — a stranger's plain
        // editor token still 403s on release via the ACL gate, so
        // this marker, not the editor role, is what makes fleet
        // eviction work. Principal stays the triggering opener, for
        // audit.
        const issueForFleet = (sessionId: string, fileIdForToken: string): string =>
          issueEngineAccessToken({
            secret: opts.engineAccess!.secret,
            principal,
            sessionId,
            tier,
            fid: fileIdForToken,
            role: 'editor',
            fleetEvict: true,
            ttlSeconds,
          }).token;
        const openReply = (
          sessionId: string,
          engineUrl: string,
          role: EngineAccessRole,
          revision: number,
          joined: boolean,
          ownershipEpoch: number,
          rehydrated = false,
        ): void =>
          reply(principal, 200, {
            ok: true,
            fileId,
            sessionId,
            engineUrl,
            accessToken: issueFor(sessionId, role),
            role,
            revision,
            joined,
            rehydrated,
            ownershipEpoch,
          });

        // Client-instance id (addendum 2, owner 2026-10-23): one
        // attached APP instance — a tab — not the user. The engine
        // refcounts attached instances per session and releases the
        // copy only when the count reaches zero. Optional: legacy
        // callers without one keep the pre-refcount behavior.
        const clientInstanceId =
          typeof b.clientInstanceId === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(b.clientInstanceId)
            ? b.clientInstanceId
            : undefined;

        // -- Per-user open cap (§9A, owner ruling 2026-10-23) --------
        // A user may hold at most openFileCap DISTINCT files open at
        // once, across all their client instances and devices.
        // Opening one more distinct file SILENTLY evicts the user
        // from their least recently used open file (their own last
        // activity there; opening stamps it). Enforcement NEVER fails
        // or refuses the open that triggered it: a failed eviction
        // (checkpoint unconfirmed at the engine, engine unreachable)
        // is logged and skipped — no-loss outranks the bound, and
        // the next open re-derives from live truth.
        //
        // The open set is DERIVED at open time, never stored: the
        // registry names every live file and its owner endpoint, and
        // each engine's /session/status reports who is attached
        // there (attachedClientsByPrincipal). Leaves, idle releases,
        // crashes and re-ownership all change that truth directly,
        // so the derived set is exact by construction.
        const deriveUserOpenSet = async (): Promise<{
          entries: UserOpenFileEntry[];
          records: Map<string, FileRegistryRecord>;
        }> => {
          const records = new Map<string, FileRegistryRecord>();
          const inputs: Array<{
            fileId: string;
            sessionId: string;
            ownerEndpoint: string;
            status: { attachedClientCount?: unknown; attachedClientsByPrincipal?: unknown };
          }> = [];
          const all = await fileRegistry.listAll();
          for (const r of all) {
            // The target file is excluded: opening it (claim, join,
            // or token refresh) never counts it toward the OTHER
            // files that could trigger an eviction.
            if (!isLiveOwner(r) || r.fileId === fileId) continue;
            records.set(r.fileId, r);
            try {
              const res = await fetch(
                `${r.ownerEndpoint.replace(/\/+$/, '')}/session/status`,
                {
                  method: 'GET',
                  headers: {
                    Authorization: `Bearer ${issueFor(r.sessionId, 'viewer')}`,
                  },
                },
              );
              if (!res.ok) continue;
              const status = (await res.json()) as {
                attachedClientCount?: unknown;
                attachedClientsByPrincipal?: unknown;
              };
              inputs.push({
                fileId: r.fileId,
                sessionId: r.sessionId,
                ownerEndpoint: r.ownerEndpoint,
                status,
              });
            } catch {
              // Unreachable engine: its files are invisible to this
              // derivation (the claim path skips it too); the next
              // open re-derives from live truth.
              continue;
            }
          }
          return { entries: userOpenSetFromStatuses(inputs, principal), records };
        };
        /**
         * Evict the opener from their LRU open file(s) until the
         * OTHER files number below the cap. Returns what happened:
         * evictedFileId (the last one evicted) and freedInstance
         * (an eviction released an engine copy via the zero-count
         * rule — the capacity-retry signal). With soleAttachedOnly,
         * evict AT MOST one file and only when the opener is that
         * session's SOLE attached user, so the detach provably frees
         * an instance (used by the claim-capacity retry: never evict
         * for an open that would still fail).
         */
        const evictLruForCap = async (
          soleAttachedOnly: boolean,
        ): Promise<{ evictedFileId: string | null; freedInstance: boolean }> => {
          try {
            const { entries, records } = await deriveUserOpenSet();
            let evictedFileId: string | null = null;
            let freedInstance = false;
            const remaining = [...entries];
            // Two modes share this walk over the LRU ranking:
            //  - NORMAL: evict until the OTHER files number below
            //    the cap (the §9A semantic eviction — shared files
            //    included; detach is per-user, co-users unaffected).
            //  - SOLE (capacity composition only): evict the ONE
            //    stalest file that is solely the opener's, so the
            //    detach provably frees an instance for a claim the
            //    exhausted fleet refused. Shared candidates are
            //    SKIPPED (they free nothing) without consuming the
            //    walk — and the cap count is irrelevant here: after
            //    the semantic eviction the user may be under the
            //    cap while the fleet is still full.
            let evictedCount = 0;
            for (;;) {
              if (remaining.length === 0) break;
              if (soleAttachedOnly ? evictedCount >= 1 : entries.length - evictedCount < openFileCap) break;
              const lru = pickLru(remaining);
              if (!lru) break;
              if (soleAttachedOnly && lru.totalAttached > lru.instances.length) {
                remaining.splice(remaining.indexOf(lru), 1);
                continue;
              }
              const lruRec = records.get(lru.fileId);
              if (!lruRec) break;
              const acl = aclRoleFor(lruRec, principal);
              const detachRole: EngineAccessRole = acl === 'editor' ? 'editor' : 'viewer';
              let detached = false;
              try {
                const res = await fetch(
                  `${lru.ownerEndpoint.replace(/\/+$/, '')}/session/detach-user`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${issueForFile(lru.sessionId, lru.fileId, detachRole)}`,
                    },
                    body: JSON.stringify({ sessionId: lru.sessionId, principal }),
                  },
                );
                if (res.ok) {
                  const j = (await res.json()) as { released?: unknown };
                  detached = true;
                  if (j.released === true) freedInstance = true;
                } else {
                  const detail = await res.text().catch(() => '');
                  console.log(
                    `[gateway] open-cap eviction refused for ${principal} file=${lru.fileId}: HTTP ${res.status} ${detail.slice(0, 200)}`,
                  );
                }
              } catch (e) {
                console.log(
                  `[gateway] open-cap eviction unreachable for ${principal} file=${lru.fileId}: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              if (!detached) break;
              evictedFileId = lru.fileId;
              evictedCount += 1;
              remaining.splice(remaining.indexOf(lru), 1);
              if (soleAttachedOnly) break;
            }
            return { evictedFileId, freedInstance };
          } catch (e) {
            // The cap is a resource bound, not an ownership or access
            // decision (§9 fail-closed does not apply to it): any
            // derivation failure degrades the cap for this open only.
            console.log(
              `[gateway] open-cap enforcement skipped for ${principal}: ${e instanceof Error ? e.message : String(e)}`,
            );
            return { evictedFileId: null, freedInstance: false };
          }
        };
        if (isLiveOwner(rec) && rec) {
          // JOIN: the response is the registered owner's endpoint +
          // a fresh token for the EXISTING session. Record the joiner
          // (FIX-B residuals 3+4): the registry gains participants[
          // principal] = the role this join token carries, so the
          // agent session resolver can bind a non-creator's agent with
          // the same role. Best-effort — a recording failure must not
          // fail an otherwise valid open; the creator is not recorded
          // (creatorPrincipal already names them).
          const joinRole = effectiveRoleFor(rec, principal);
          if (!joinRole) {
            // Issue #51 section 4: no grant -> no join. The file
            // cannot even be opened by this principal.
            return fail(principal, 403, 'no access grant for this file');
          }
          // Issue #100: JOIN liveness probe. A registry record can
          // outlive its engine copy (crash/recycle, lost beacon,
          // swallowed registry.release failure) while the lease is
          // still warm; trusting isLiveOwner alone then returns a
          // JOIN to a dead endpoint, and the client's reconnect loop
          // re-runs the same dead lookup until the lease lapses —
          // a refreshed page sits empty with a manual "Reconnect
          // now" banner. Verify the recorded owner actually holds
          // THIS session and reports it active BEFORE replying JOIN.
          // Anything else falls through to the CLAIM path below
          // (same sessionId, epoch+1, rehydrate on a live instance).
          // This runs once per open/refresh event only — never per
          // call: steady-state calls use the direct signed link
          // (§9 corrected model). A false-negative probe on a live
          // session is harmless: the claim path re-adopts the live
          // session (engine /session/claim on a live same-file
          // session returns 200 joined:true).
          let ownerLive = false;
          try {
            const probeRes = await fetch(
              `${rec.ownerEndpoint.replace(/\/+$/, '')}/session/status`,
              {
                method: 'GET',
                headers: { Authorization: `Bearer ${issueFor(rec.sessionId, joinRole)}` },
                signal: AbortSignal.timeout(5000),
              },
            );
            if (probeRes.ok) {
              const probe = (await probeRes.json()) as {
                status?: unknown;
                sessionId?: unknown;
              };
              ownerLive = probe.status === 'active' && probe.sessionId === rec.sessionId;
            }
          } catch {
            ownerLive = false;
          }
          if (ownerLive) {
            if (principal !== rec.creatorPrincipal) {
              await fileRegistry
                .noteParticipant(fileId, rec.sessionId, rec.ownershipEpoch, principal, joinRole)
                .catch(() => undefined);
            }
            // Attach this client instance to the live session on its
            // owning engine (refcount, addendum 2). Best-effort exactly
            // like noteParticipant: a failed attach must not fail a
            // valid join — the instance's heartbeats re-attach it.
            if (clientInstanceId) {
              try {
                const attachRes = await fetch(`${rec.ownerEndpoint.replace(/\/+$/, '')}/session/attach`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${issueFor(rec.sessionId, joinRole)}`,
                  },
                  body: JSON.stringify({ sessionId: rec.sessionId, clientInstanceId }),
                });
                if (!attachRes.ok) {
                  console.log(`[gateway] join attach refused file=${fileId}: HTTP ${attachRes.status}`);
                }
              } catch (e) {
                console.log(`[gateway] join attach failed file=${fileId}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            // Open cap (§9A): this join may have put the user over the
            // cap in OTHER files — evict their LRU one. Never blocks
            // or fails the join (evictLruForCap swallows its errors).
            await evictLruForCap(false);
            return openReply(
              rec.sessionId,
              rec.ownerEndpoint,
              joinRole,
              rec.currentRevision,
              true,
              rec.ownershipEpoch,
            );
          }
        }
        // CLAIM path — PLACEMENT (owner spec, 2026-10-23; interim
        // fleet-5 rule, 2026-10-24): a file with no live copy must be
        // placed on a FREE engine instance. The pool is the
        // ENGINE_INSTANCES fleet map (separate Cloud Run services; the
        // XL pool is retired — ALL tiers claim from the standard pool,
        // spec §2.1). Candidates are tried in ROTATION order (spec
        // §2.2) — map order starting at the rotation cursor, deduped
        // by URL; the home instance no longer gets first-try priority.
        // A 409 'engine already
        // owns a different file' (or 'fenced') from an instance means
        // THAT instance is busy: try the next one, never fail the
        // open. A refused claim created no session on that instance,
        // so there is nothing to release for it. A connection-level
        // failure to a candidate (refused / DNS / reset / timeout —
        // the fetch throws before any response) likewise means THAT
        // instance is unavailable: try the next one. Only when EVERY
        // candidate is unreachable does the open fail 502 with an
        // 'unreachable' message, distinct from the all-busy capacity
        // 503; a busy+unreachable mix still ends at the 503, because
        // capacity is the binding constraint the user can act on.
        // Every other outcome keeps the pre-placement behavior
        // exactly (non-409 HTTP errors → 502, other 409s such as a
        // rehydrate checksum mismatch pass through as 409). If every
        // candidate is busy the open first tries the capacity retries
        // in order — the opener's own sole-attached file (§9A), then
        // the fleet-global LRU whole-file eviction (spec §2.3) — and
        // only when nothing frees does it fail with a clear capacity
        // error — no silent queueing, no double-booking an instance.
        // A connection error can arrive AFTER the engine actually
        // claimed (response lost): the registry CAS below still
        // decides the winner, the compensation release handles a
        // claim that lost the CAS, and an orphan whose CAS never ran
        // is freed by the engine's idle sweeper (SESSION_LIFECYCLE)
        // since no client ever attaches or heartbeats to it.
        // Interim fleet-5 rule (spec §2.1): tier routing collapses to
        // ONE pool. The XL services are deleted (same-size
        // placeholders), so ALL files — including over-p75 ones —
        // claim from the standard pool. engineInstancesXl is still
        // parsed for backward compatibility but is never a placement
        // pool anymore.
        const tierPool: Record<string, string> = engineInstances;
        const instances: Record<string, string> =
          Object.keys(tierPool).length > 0
            ? tierPool
            : { [engineInstanceId]: opts.engineAccess.tiers[tier] };
        // Rotation (§2.2): base order is map order, deduped by URL;
        // the tried order starts at the rotation cursor.
        const baseIds: string[] = [];
        {
          const seenUrls = new Set<string>();
          for (const id of Object.keys(instances)) {
            const url = (instances[id] as string).replace(/\/+$/, '');
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            baseIds.push(id);
          }
        }
        const rotationStart = baseIds.length > 0 ? claimRotationCursor % baseIds.length : 0;
        const orderedIds: string[] = [
          ...baseIds.slice(rotationStart),
          ...baseIds.slice(0, rotationStart),
        ];
        // Reuse the expired record's sessionId when there is one: the
        // engine rehydrates that released session (snapshot + journal
        // + checksum) instead of minting a divergent one.
        const sessionId = rec?.sessionId ?? newSessionId();
        const epoch = rec ? rec.ownershipEpoch + 1 : 1;
        // Issue #51 section 4: the claim/rehydrate door is
        // grant-gated BEFORE anything is claimed — a no-grant
        // principal must not evict or rehydrate someone else's file
        // by reopening it after the lease lapses. (A null record
        // means a brand-new file: the caller is its creator.)
        const claimRole = effectiveRoleFor(rec, principal);
        if (!claimRole) {
          return fail(principal, 403, 'no access grant for this file');
        }
        // The claim iteration (placement, 2026-10-23) lives in a
        // closure returning its outcome, so the CAPACITY RETRY below
        // can re-run it ONCE after a cap eviction frees an instance.
        // A non-busy, non-unreachable claim failure is FATAL to the
        // open (pre-placement behavior, preserved): it is reported
        // in the outcome instead of replied to inside the loop.
        // Issue #117: fatal claim failures and the CAS-lost outcome
        // carry a machine-readable `code` (ENGINE_CLAIM_FAILED /
        // CLAIM_LOST) so the client can tell them apart from a
        // genuine live-session conflict. Statuses and messages are
        // unchanged; no 409 on this path means "already open" — a
        // live session JOINS, it never conflicts.
        type ClaimAttempt = {
          claimJson: { sessionId?: unknown; revision?: unknown } | null;
          chosenId: string;
          engineUrl: string;
          busyRefusals: number;
          busyEngines: string[];
          lastBusyDetail: string;
          unreachable: number;
          lastUnreachableDetail: string;
          fatalClaim: { status: number; message: string } | null;
        };
        const attemptClaims = async (): Promise<ClaimAttempt> => {
          const out: ClaimAttempt = {
            claimJson: null,
            chosenId: '',
            engineUrl: '',
            busyRefusals: 0,
            busyEngines: [],
            lastBusyDetail: '',
            unreachable: 0,
            lastUnreachableDetail: '',
            fatalClaim: null,
          };
          for (const candId of orderedIds) {
            const candUrl = (instances[candId] as string).replace(/\/+$/, '');
            let parsed: { sessionId?: unknown; revision?: unknown } | null = null;
            let claimRes: Response;
            try {
              claimRes = await fetch(`${candUrl}/session/claim`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${issueFor(sessionId, 'editor')}`,
                },
                body: JSON.stringify({
                  fileId,
                  sessionId,
                  ...(clientInstanceId ? { clientInstanceId } : {}),
                }),
              });
            } catch (e) {
              // Connection-level failure (refused / DNS / reset /
              // timeout): this candidate is UNAVAILABLE — record it
              // and try the next instance, exactly like a busy
              // refusal. Only an all-unreachable pool fails the open
              // (502, below).
              out.unreachable += 1;
              out.lastUnreachableDetail = e instanceof Error ? e.message : String(e);
              continue;
            }
            const claimText = await claimRes.text();
            try {
              parsed = JSON.parse(claimText) as { sessionId?: unknown; revision?: unknown };
            } catch {
              parsed = null;
            }
            if (!claimRes.ok) {
              const detail =
                parsed && typeof (parsed as { error?: unknown }).error === 'string'
                  ? ((parsed as { error: string }).error as string)
                  : `HTTP ${claimRes.status}`;
              if (
                claimRes.status === 409 &&
                (detail.startsWith('engine already owns a different file') || detail === 'fenced')
              ) {
                out.busyRefusals += 1;
                out.lastBusyDetail = detail;
                // #109: a busy refusal is claim-round proof that
                // this engine holds a session RIGHT NOW, even if
                // the registry record for it has gone lease-lapsed
                // (fenced heartbeat, registry error, restart gap).
                // The fleet walk uses this set as its second-pass
                // filter, so a lapsed lease can never blind it.
                if (!out.busyEngines.includes(candUrl)) out.busyEngines.push(candUrl);
                continue;
              }
              out.fatalClaim = {
                status: claimRes.status === 409 ? 409 : 502,
                message: `engine claim failed: ${detail}`,
              };
              return out;
            }
            out.chosenId = candId;
            out.engineUrl = candUrl;
            out.claimJson = parsed;
            break;
          }
          return out;
        };
        // FLEET EVICTION (interim fleet-5 rule, spec §2.3): the LAST
        // resort when the pool is full and no opener-scoped eviction
        // freed a service. Walks the pool's live files in global-LRU
        // order (session-level last activity: edits + selection
        // heartbeats; opening stamps it; ties break to the smaller
        // fileId, the pickLru rule) and whole-file releases the first
        // one whose engine confirms it: POST /session/release
        // {force: true} with a FLEET token naming THAT file (the
        // #106 fid lesson, plus the fleetEvict claim: the engine's
        // #104 ACL gate rightly refuses a stranger's plain editor
        // token on release, so only the gateway's fleet authority
        // can evict another user's file). The engine checkpoints
        // BEFORE any detach
        // inside evictSession, so a 200 + released:true IS the
        // checkpoint confirmation — a refused or unconfirmed release
        // skips to the next candidate and nothing is lost.
        // Whole-file by design: every attached instance is detached
        // and every SSE stream gets the release event, so the file
        // frees its service for the claim in flight. This is gateway
        // fleet management, not a user action: it needs no grant on
        // the evicted file (else capacity could never be freed when
        // every file belongs to someone else) and discloses no
        // workbook content. If no candidate frees, the open falls
        // through to the capacity 503 below — no-loss outranks the
        // bound, the same philosophy as the cap's failed-eviction
        // skip.
        const evictFleetLru = async (
          busyEngines: string[],
        ): Promise<{
          evictedFileId: string | null;
          freedService: boolean;
        }> => {
          try {
            const poolUrls = new Set(
              Object.values(instances).map((u) => (u as string).replace(/\/+$/, '')),
            );
            // #109 second pass: engines that JUST refused the claim
            // as busy hold a session now, whatever their registry
            // record's lease says. A lease-lapsed record on such an
            // engine is a candidate too — the status probe below is
            // ground truth (its token names the record's sessionId,
            // and the engine 401s a mismatch), so a stale record can
            // never release the wrong file, and the release still
            // requires engine confirmation with checkpoint first.
            const busySet = new Set(busyEngines.map((u) => u.replace(/\/+$/, '')));
            const all = await fileRegistry.listAll();
            type FleetLive = {
              fileId: string;
              sessionId: string;
              ownerEndpoint: string;
              lastActivityAt: number;
            };
            const live: FleetLive[] = [];
            for (const r of all) {
              if (r.fileId === fileId) continue;
              const endpoint = r.ownerEndpoint.replace(/\/+$/, '');
              if (!poolUrls.has(endpoint)) continue;
              if (!isLiveOwner(r) && !busySet.has(endpoint)) continue;
              try {
                const res = await fetch(`${endpoint}/session/status`, {
                  method: 'GET',
                  headers: { Authorization: `Bearer ${issueFor(r.sessionId, 'viewer')}` },
                });
                if (!res.ok) {
                  console.log(
                    `[gateway] fleet eviction probe refused for file=${r.fileId}: HTTP ${res.status}`,
                  );
                  continue;
                }
                const st = (await res.json()) as {
                  lastActivityAt?: unknown;
                  attachedClientsByPrincipal?: unknown;
                };
                let last =
                  typeof st.lastActivityAt === 'number' && Number.isFinite(st.lastActivityAt)
                    ? st.lastActivityAt
                    : 0;
                if (st.attachedClientsByPrincipal && typeof st.attachedClientsByPrincipal === 'object') {
                  for (const v of Object.values(
                    st.attachedClientsByPrincipal as Record<string, unknown>,
                  )) {
                    const la = (v as { lastActivityAt?: unknown } | null)?.lastActivityAt;
                    if (typeof la === 'number' && Number.isFinite(la) && la > last) last = la;
                  }
                }
                live.push({
                  fileId: r.fileId,
                  sessionId: r.sessionId,
                  ownerEndpoint: endpoint,
                  lastActivityAt: last,
                });
              } catch (e) {
                // Unreachable engine: its files cannot be evicted
                // from here; the claim path skips it too. The next
                // open re-derives.
                console.log(
                  `[gateway] fleet eviction probe unreachable for file=${r.fileId}: ${e instanceof Error ? e.message : String(e)}`,
                );
                continue;
              }
            }
            console.log(
              `[gateway] fleet eviction candidates: ${live.length} (busy engines: ${busySet.size})`,
            );
            live.sort(
              (a, b) =>
                a.lastActivityAt - b.lastActivityAt ||
                (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0),
            );
            // #109 follow-up: log the full ranking, not just the count —
            // the victim is otherwise invisible (success used to log
            // nothing), which is exactly why the live leg could not be
            // resolved from logs. Eviction is rare, so verbosity here
            // is cheap.
            console.log(
              `[gateway] fleet eviction ranked (least-recent first): ${live
                .map(
                  (c) =>
                    `${c.fileId}@${c.lastActivityAt} (${new Date(c.lastActivityAt).toISOString()} on ${c.ownerEndpoint})`,
                )
                .join(', ') || '(none)'}`,
            );
            for (const cand of live) {
              try {
                const res = await fetch(`${cand.ownerEndpoint}/session/release`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${issueForFleet(cand.sessionId, cand.fileId)}`,
                  },
                  body: JSON.stringify({
                    sessionId: cand.sessionId,
                    reason: 'fleet-eviction',
                    force: true,
                  }),
                });
                if (!res.ok) {
                  console.log(
                    `[gateway] fleet eviction refused for file=${cand.fileId}: HTTP ${res.status}`,
                  );
                  continue;
                }
                const j = (await res.json()) as {
                  released?: unknown;
                  alreadyReleased?: unknown;
                };
                if (j.released === true || j.alreadyReleased === true) {
                  console.log(
                    `[gateway] fleet eviction EVICTED file=${cand.fileId} lastActivityAt=${cand.lastActivityAt} endpoint=${cand.ownerEndpoint}`,
                  );
                  return { evictedFileId: cand.fileId, freedService: true };
                }
              } catch (e) {
                console.log(
                  `[gateway] fleet eviction unreachable for file=${cand.fileId}: ${e instanceof Error ? e.message : String(e)}`,
                );
                continue;
              }
            }
            console.log(
              `[gateway] fleet eviction freed nothing (${live.length} candidates tried)`,
            );
            return { evictedFileId: null, freedService: false };
          } catch (e) {
            console.log(
              `[gateway] fleet eviction skipped for ${principal}: ${e instanceof Error ? e.message : String(e)}`,
            );
            return { evictedFileId: null, freedService: false };
          }
        };
        // §9A ORDER: rank → checkpoint-confirm → detach → claim.
        // When this open crosses the cap, the semantic LRU
        // eviction runs BEFORE the claim (the design-doc sequence);
        // the post-claim enforcement below then has nothing to do,
        // and the capacity retry further down only frees an extra
        // instance when the fleet itself is exhausted. Below the
        // cap this call is a no-op.
        await evictLruForCap(false);
        let attempt = await attemptClaims();
        if (attempt.fatalClaim) {
          return failExtra(principal, attempt.fatalClaim.status, attempt.fatalClaim.message, { code: 'ENGINE_CLAIM_FAILED' });
        }
        if (!attempt.chosenId && !(orderedIds.length > 0 && attempt.unreachable === orderedIds.length)) {
          // CAPACITY RETRY (§9A composition): every candidate is
          // busy. The semantic LRU eviction already ran above; the
          // fleet is STILL full (the evicted file's copy may be
          // shared, or other users hold the rest). Freeing one more
          // of the OPENER'S OWN sole-attached files — their stalest
          // — makes room for the claim that is already in flight;
          // if one was freed, retry the claim iteration ONCE
          // against the updated pool. This step is purely
          // mechanical (it serves this open's placement); the
          // cap's semantic eviction is the one above.
          const capEvict = await evictLruForCap(true);
          if (capEvict.freedInstance) {
            attempt = await attemptClaims();
            if (attempt.fatalClaim) {
              return failExtra(principal, attempt.fatalClaim.status, attempt.fatalClaim.message, { code: 'ENGINE_CLAIM_FAILED' });
            }
          }
        }
        // FLEET EVICTION (spec §2.3, LAST resort): the semantic cap
        // eviction and the opener's sole-file retry both ran and the
        // fleet is STILL full. Evict the globally LRU live file in
        // the pool (whole-file release, checkpoint confirmed by the
        // engine) and retry the claim ONCE against the freed service.
        // This runs only when some candidate answered — an
        // all-unreachable pool has nothing to evict and keeps the
        // 502 below.
        let fleetEvictionAttempted = false;
        let fleetEvictedFileId: string | null = null;
        if (!attempt.chosenId && !(orderedIds.length > 0 && attempt.unreachable === orderedIds.length)) {
          fleetEvictionAttempted = true;
          const fleetEvict = await evictFleetLru(attempt.busyEngines);
          fleetEvictedFileId = fleetEvict.evictedFileId;
          if (fleetEvict.freedService) {
            attempt = await attemptClaims();
            if (attempt.fatalClaim) {
              return failExtra(principal, attempt.fatalClaim.status, attempt.fatalClaim.message, { code: 'ENGINE_CLAIM_FAILED' });
            }
          }
        }
        if (!attempt.chosenId) {
          // The pool is the standard pool whenever ENGINE_INSTANCES
          // is configured (interim fleet-5 rule); the single-URL
          // fallback keeps the open's tier label.
          const poolName = Object.keys(engineInstances).length > 0 ? 'standard' : tier;
          if (orderedIds.length > 0 && attempt.unreachable === orderedIds.length) {
            // Every candidate failed at connection level — nothing
            // in the pool even answered. 502 with the unreachable
            // wording, distinct from the capacity 503 below.
            return fail(
              principal,
              502,
              `engine instances unreachable: all ${orderedIds.length} engine instance(s) in the ${poolName} pool could not be reached (last error: ${attempt.lastUnreachableDetail || 'unknown'}; ${attempt.unreachable} unreachable)`,
            );
          }
          return fail(
            principal,
            503,
            `no free engine instance: all ${orderedIds.length} engine instance(s) in the ${poolName} pool hold other files (last refusal: ${attempt.lastBusyDetail || 'none'}; ${attempt.busyRefusals} busy${attempt.unreachable > 0 ? `, ${attempt.unreachable} unreachable` : ''}${fleetEvictionAttempted ? (fleetEvictedFileId ? `; fleet eviction freed ${fleetEvictedFileId} but the retry claim still found no free instance` : '; fleet eviction attempted, no service freed') : ''})`,
          );
        }
        // Advance the rotation cursor past the chosen service, so the
        // next claim starts after it (§2.2).
        if (orderedIds.length > 0) {
          const pos = orderedIds.indexOf(attempt.chosenId);
          if (pos >= 0) claimRotationCursor = (rotationStart + pos + 1) % orderedIds.length;
        }
        const claimJson = attempt.claimJson;
        const chosenId = attempt.chosenId;
        const engineUrl = attempt.engineUrl;
        const engineSessionId = isSessionId(claimJson?.sessionId) ? claimJson.sessionId : sessionId;
        const claimRevision =
          typeof claimJson?.revision === 'number' && Number.isFinite(claimJson.revision)
            ? Math.floor(claimJson.revision)
            : (rec?.currentRevision ?? 0);
        // Compensation (batch-2 live wedge): the engine claim above has
        // already created/rehydrated a session on the chosen instance.
        // If the registry CAS now throws or is lost WITHOUT this open
        // adopting that exact session, the engine copy is an orphan the
        // registry knows nothing about — the ownership heartbeat treats
        // a missing record as a permanent grace window, so the orphan
        // never self-clears and every later claim for a different file
        // on that instance hits the §9 hard refusal. Release the
        // just-claimed engine session best-effort instead; the engine's
        // idle sweeper remains the backstop.
        const releaseClaimedSession = async (): Promise<void> => {
          try {
            await fetch(`${engineUrl}/session/release`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${issueFor(engineSessionId, 'editor')}`,
              },
              body: JSON.stringify({
                sessionId: engineSessionId,
                reason: 'gateway-claim-failed',
                // The claim attached the opener's client instance
                // (refcount); compensation is an internal teardown of
                // a session this open created but did not adopt, so it
                // must evict outright, not merely detach.
                force: true,
              }),
            });
          } catch {
            // Best-effort only: a failed release must not mask the
            // registry error the caller is about to receive.
          }
        };
        let won: boolean;
        try {
          won = await fileRegistry.claim(
            {
              fileId,
              sessionId: engineSessionId,
              ownerInstance: chosenId,
              ownerEndpoint: engineUrl,
              leaseExpiry: Date.now() + (opts.ownershipLeaseMs ?? ownershipLeaseMs()),
              ownershipEpoch: epoch,
              currentRevision: claimRevision,
              storedRevision: rec?.storedRevision ?? 0,
              updatedAt: Date.now(),
              creatorPrincipal: rec?.creatorPrincipal ?? principal,
              // Grants are owner-recorded access state, not session
              // state: like creatorPrincipal they SURVIVE the claim
              // (participants, join-time advisory data, reset here).
              grants: rec?.grants,
            },
            rec ? rec.ownershipEpoch : null,
          );
        } catch {
          await releaseClaimedSession();
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!won) {
          // CAS race lost: re-read and JOIN the winner (never build a
          // competing copy).
          let winner: Awaited<ReturnType<FileRegistry['lookup']>>;
          try {
            winner = await fileRegistry.lookup(fileId);
          } catch {
            await releaseClaimedSession();
            return fail(principal, 503, 'session registry unavailable');
          }
          if (winner && isLiveOwner(winner)) {
            // Same participant recording as the plain JOIN path.
            const joinRole = effectiveRoleFor(winner, principal);
            if (!joinRole) {
              return fail(principal, 403, 'no access grant for this file');
            }
            if (principal !== winner.creatorPrincipal) {
              await fileRegistry
                .noteParticipant(fileId, winner.sessionId, winner.ownershipEpoch, principal, joinRole)
                .catch(() => undefined);
            }
            if (clientInstanceId) {
              try {
                const attachRes = await fetch(`${winner.ownerEndpoint.replace(/\/+$/, '')}/session/attach`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${issueFor(winner.sessionId, joinRole)}`,
                  },
                  body: JSON.stringify({ sessionId: winner.sessionId, clientInstanceId }),
                });
                if (!attachRes.ok) {
                  console.log(`[gateway] join attach refused file=${fileId}: HTTP ${attachRes.status}`);
                }
              } catch (e) {
                console.log(`[gateway] join attach failed file=${fileId}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            // Our engine claim built a duplicate copy of the winner's
            // session (or an empty pending one) on the chosen instance:
            // release it unless it IS the winner's session.
            if (winner.sessionId !== engineSessionId) await releaseClaimedSession();
            // Open cap (§9A): same enforcement as the plain JOIN path.
            await evictLruForCap(false);
            return openReply(
              winner.sessionId,
              winner.ownerEndpoint,
              joinRole,
              winner.currentRevision,
              true,
              winner.ownershipEpoch,
            );
          }
          await releaseClaimedSession();
          return failExtra(principal, 409, 'ownership claim lost and no live owner found', { code: 'CLAIM_LOST' });
        }
        // The creator (first claim) is always an editor. Issue #36:
        // forward the engine's rehydrated flag (snapshot rehydrate OR
        // library recovery) so the client never reloads upload bytes
        // over a session that already holds the workbook.
        // Issue #51: a NON-creator claiming an expired session (the
        // rehydrate door) resolves their role exactly like a joiner —
        // before this, this branch replied 'editor' unconditionally
        // while preserving the original creatorPrincipal, so a
        // viewer-granted user who reopened after the lease lapsed was
        // silently promoted to editor.
        // Open cap (§9A): the claim succeeded and the CAS adopted it —
        // only now may this open evict the user's LRU other file (a
        // claim that failed must never cost the user a file).
        await evictLruForCap(false);
        return openReply(
          engineSessionId,
          engineUrl,
          claimRole,
          claimRevision,
          false,
          epoch,
          (claimJson as { rehydrated?: unknown } | null)?.rehydrated === true,
        );
      }

      // GET /api/engine/share?fileId=: the read side of the share
      // contract (issue #71 — the web Share dialog's data source).
      // Returns the file's owner, the CALLER's own role, and the
      // recorded grants, all resolved through aclRoleFor (design doc
      // section 8) on the current registry record. A caller with no
      // role on the file gets the same 404 as a nonexistent file —
      // the access list is visible only to people on it, and the
      // gateway does not leak which fileIds exist (the catalog
      // guard's rule). Read-only: grants change ONLY through the
      // POST below (noteGrant's single call site, S7).
      if (path === '/api/engine/share' && method === 'GET') {
        if (!fileRegistry) {
          return fail(principal, 503, 'session registry unavailable');
        }
        const shareFileId = url.searchParams.get('fileId') ?? '';
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(shareFileId)) {
          return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        let shareRec: Awaited<ReturnType<FileRegistry['lookup']>>;
        try {
          shareRec = await fileRegistry.lookup(shareFileId);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!shareRec) {
          return fail(principal, 404, 'file not found');
        }
        const callerRole = aclRoleFor(shareRec, principal);
        if (!callerRole) {
          return fail(principal, 404, 'file not found');
        }
        // Link-only callers (issue #84c) see their own link role but
        // NOT the grant list: the access list is visible only to
        // people on it, and a link role is not a grant. Owners and
        // grantees see the list as before.
        const isExplicit =
          principal === shareRec.creatorPrincipal || shareRec.grants?.[principal] !== undefined;
        const grants = isExplicit
          ? Object.entries(shareRec.grants ?? {})
              .map(([p, r]) => ({ principal: p, role: r }))
              .sort((a, b) => (a.principal < b.principal ? -1 : a.principal > b.principal ? 1 : 0))
          : [];
        return reply(principal, 200, {
          ok: true,
          fileId: shareFileId,
          owner: shareRec.creatorPrincipal,
          role: callerRole,
          grants,
          linkShare: shareRec.linkShare ?? null,
        });
      }

      // POST /api/engine/share: the file's CREATOR records (or revokes)
      // another principal's access grant for a file — the server-side
      // authority the open handler resolves roles from (issue #51).
      // Body: { fileId, principal, role: 'editor' | 'viewer' | null }
      // (null revokes). Creator-only: anyone else gets 403, and a file
      // with no registry record gets the same 404 as a nonexistent one.
      // The grant lands in the registry (grants + participants mirror
      // + the section-5 audit log) and governs every FUTURE open for
      // that principal: no grant -> the next open is denied outright.
      // It also governs LIVE sessions immediately (design doc section
      // 5): the engine re-derives each caller's role from this record
      // on every request, so a demotion fails the principal's next
      // write and a revocation cuts their next read — the role frozen
      // in an already-minted token (10-minute TTL) is only a fallback
      // for files with no registry record.
      if (path === '/api/engine/share' && method === 'POST') {
        if (!fileRegistry) {
          return fail(principal, 503, 'session registry unavailable');
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(principal, 400, bodyError(e));
        }
        const b = (body ?? {}) as { fileId?: unknown; principal?: unknown; role?: unknown };
        if (typeof b.fileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.fileId)) {
          return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        if (typeof b.principal !== 'string' || b.principal.length < 1 || b.principal.length > 128) {
          return fail(principal, 400, 'principal must be a string of 1..128 chars');
        }
        if (b.role !== undefined && b.role !== null && b.role !== 'editor' && b.role !== 'viewer') {
          return fail(principal, 400, "role must be 'editor', 'viewer' or null (revoke)");
        }
        if (b.principal === principal) {
          return fail(principal, 400, 'cannot change your own role');
        }
        let rec: Awaited<ReturnType<FileRegistry['lookup']>>;
        try {
          rec = await fileRegistry.lookup(b.fileId);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!rec) {
          return fail(principal, 404, 'file not found');
        }
        if (!aclAllows(rec, principal, 'acl')) {
          return fail(principal, 403, 'only the file owner can share this file');
        }
        const role = (b.role ?? null) as EngineAccessRole | null;
        let noted: boolean;
        try {
          noted = await fileRegistry.noteGrant(b.fileId, b.principal, role, principal);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!noted) {
          return fail(principal, 404, 'file not found');
        }
        return reply(principal, 200, { ok: true, fileId: b.fileId, principal: b.principal, role });
      }

      // GET /api/users/by-email?fileId=&email= (issue #84a): resolve
      // an email to the principal the Share dialog grants to. The
      // caller MUST own the file being shared (checked before any
      // directory read, so non-owners cannot probe emails); the
      // directory only knows people who have signed in at least once.
      if (path === '/api/users/by-email' && method === 'GET') {
        if (!fileRegistry) {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!userDirectory) {
          return fail(principal, 503, 'user directory unavailable');
        }
        const byFileId = url.searchParams.get('fileId') ?? '';
        const byEmail = url.searchParams.get('email') ?? '';
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(byFileId)) {
          return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        if (!isDirectoryEmail(byEmail)) {
          return fail(principal, 400, 'email must be a valid email address');
        }
        let byRec: Awaited<ReturnType<FileRegistry['lookup']>>;
        try {
          byRec = await fileRegistry.lookup(byFileId);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!byRec) {
          return fail(principal, 404, 'file not found');
        }
        // No-leak posture (mirrors share GET): a non-owner gets the
        // same 404 as a nonexistent file, never a 403 that confirms
        // the file exists — and the directory is never read for them.
        if (!aclAllows(byRec, principal, 'acl')) {
          return fail(principal, 404, 'file not found');
        }
        let entry: Awaited<ReturnType<UserDirectory['lookupByEmail']>>;
        try {
          entry = await userDirectory.lookupByEmail(byEmail);
        } catch {
          return fail(principal, 503, 'user directory unavailable');
        }
        if (!entry) {
          return fail(principal, 404, 'no account found for that email');
        }
        return reply(principal, 200, {
          ok: true,
          principal: entry.principal,
          email: entry.email,
          ...(entry.name ? { name: entry.name } : {}),
        });
      }

      // POST /api/engine/share/link (issue #84c): the file's creator
      // switches link sharing on (with a role for link users) or off
      // (role null). The role lands in the registry record, so every
      // aclRoleFor consumer — open, catalog guard, agent binding —
      // admits link users at that role while it is on.
      if (path === '/api/engine/share/link' && method === 'POST') {
        if (!fileRegistry) {
          return fail(principal, 503, 'session registry unavailable');
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(principal, 400, bodyError(e));
        }
        const b = (body ?? {}) as { fileId?: unknown; role?: unknown };
        if (typeof b.fileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.fileId)) {
          return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        if (b.role !== undefined && b.role !== null && b.role !== 'editor' && b.role !== 'viewer') {
          return fail(principal, 400, "role must be 'editor', 'viewer' or null (link sharing off)");
        }
        let rec: Awaited<ReturnType<FileRegistry['lookup']>>;
        try {
          rec = await fileRegistry.lookup(b.fileId);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!rec) {
          return fail(principal, 404, 'file not found');
        }
        if (!aclAllows(rec, principal, 'acl')) {
          return fail(principal, 403, 'only the file owner can change link sharing for this file');
        }
        const role = (b.role ?? null) as EngineAccessRole | null;
        let noted: boolean;
        try {
          noted = await fileRegistry.noteLinkShare(b.fileId, role, principal);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!noted) {
          return fail(principal, 404, 'file not found');
        }
        return reply(principal, 200, {
          ok: true,
          fileId: b.fileId,
          linkShare: role === null ? null : { role },
        });
      }

      // POST /api/engine/share/transfer (issue #84b): the file's
      // creator hands ownership to a principal who ALREADY holds a
      // grant on the file (that precondition is what keeps a typo
      // from orphaning the file). The previous owner becomes an
      // editor grant. The workspace catalog record moves with it when
      // one exists; a catalog failure is reported honestly
      // (catalogTransferred:false) rather than failing a transfer
      // the registry has already committed — the two stores have no
      // shared transaction, and the registry is the authority.
      if (path === '/api/engine/share/transfer' && method === 'POST') {
        if (!fileRegistry) {
          return fail(principal, 503, 'session registry unavailable');
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(principal, 400, bodyError(e));
        }
        const b = (body ?? {}) as { fileId?: unknown; principal?: unknown };
        if (typeof b.fileId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.fileId)) {
          return fail(principal, 400, 'fileId must match [A-Za-z0-9._:-]{1,128}');
        }
        if (typeof b.principal !== 'string' || b.principal.length < 1 || b.principal.length > 128) {
          return fail(principal, 400, 'principal must be a string of 1..128 chars');
        }
        if (b.principal === principal) {
          return fail(principal, 400, 'cannot transfer ownership to yourself');
        }
        let rec: Awaited<ReturnType<FileRegistry['lookup']>>;
        try {
          rec = await fileRegistry.lookup(b.fileId);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!rec) {
          return fail(principal, 404, 'file not found');
        }
        if (!aclAllows(rec, principal, 'acl')) {
          return fail(principal, 403, 'only the file owner can transfer ownership of this file');
        }
        if (rec.grants?.[b.principal] !== 'editor' && rec.grants?.[b.principal] !== 'viewer') {
          return fail(principal, 400, 'transfer target must already have access to this file');
        }
        let moved: boolean;
        try {
          moved = await fileRegistry.transferOwnership(b.fileId, b.principal, principal);
        } catch {
          return fail(principal, 503, 'session registry unavailable');
        }
        if (!moved) {
          return fail(principal, 404, 'file not found');
        }
        let catalogTransferred = false;
        if (userFileCatalog) {
          try {
            const catRec = await userFileCatalog.get(b.fileId);
            if (catRec && catRec.ownerPrincipal === principal) {
              catalogTransferred = (await userFileCatalog.transfer(b.fileId, principal, b.principal)) !== null;
            } else if (!catRec) {
              // Registry-only file (e.g. engine-opened, never
              // catalogued): nothing to move, and nothing is lost.
              catalogTransferred = true;
            }
          } catch {
            catalogTransferred = false;
          }
        }
        return reply(principal, 200, {
          ok: true,
          fileId: b.fileId,
          owner: b.principal,
          previousOwner: principal,
          catalogTransferred,
        });
      }

      // -- storage download signing (save/download separation) --------
      // A /download committed the serialized workbook into the engine's
      // library store and returned only an entryId. The client now asks
      // HERE for a signed URL (JWT auth + per-principal rate limit have
      // already run above — issuance is the gateway's handshake, exactly
      // like engine access), then fetches the bytes DIRECTLY from the
      // engine service: GET {engineOrigin}/storage/{entryId}?st={token}.
      // The gateway never proxies those bytes. The token binds
      // { entryId, principal, exp: now+120s }; the engine re-checks the
      // store index entry's owner against the token's principal before
      // serving, so a token minted for one tenant fetches nothing of
      // another's. Fail closed: no signing secret → 501, no unsigned
      // fallback (the /download metadata response is unaffected).
      if (path === '/api/storage/sign' && method === 'POST') {
        const secret = opts.storageSign?.secret ?? opts.engineAccess?.secret;
        if (!secret) {
          return fail(
            principal,
            501,
            'storage signing is not configured on this gateway (ENGINE_ACCESS_SECRET is not set)',
          );
        }
        let body: unknown;
        try {
          body = await readBody(req);
        } catch (e) {
          return fail(principal, 400, bodyError(e));
        }
        const entryId = (body as { entryId?: unknown } | undefined)?.entryId;
        if (typeof entryId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(entryId)) {
          return fail(principal, 400, 'entryId must match [A-Za-z0-9._-]{1,128}');
        }
        const { token: st, claims } = issueStorageToken({
          secret,
          entryId,
          principal,
          ttlSeconds: opts.storageSign?.ttlSeconds ?? STORAGE_TOKEN_TTL_SECONDS,
        });
        const origin = (
          opts.storageSign?.publicUrl ??
          process.env.ENGINE_PUBLIC_URL ??
          opts.engineAccess?.tiers.standard ??
          routes['/api/engine'] ??
          ''
        ).replace(/\/+$/, '');
        return reply(principal, 200, {
          ok: true,
          url: `${origin}/storage/${entryId}?st=${st}`,
          expiresAt: claims.exp * 1000,
        });
      }

      // -- product layer: workspace file catalog + upload issuance ----
      // (CONTRACT §Gateway endpoints). Auth + per-principal rate limit
      // have already run above. Caps are enforced HERE, server-side:
      // at upload-grant (declared size + count) AND again at
      // complete-upload against the ACTUAL staged bytes.
      if (path === '/api/files' || path.startsWith('/api/files/')) {
        if (!userTierStore || !userFileCatalog) {
          return fail(principal, 503, 'product layer unavailable');
        }
        const catalog: UserFileCatalog = userFileCatalog;
        const seg = path.slice('/api/files'.length).split('/').filter((s) => s.length > 0);
        const tier = await tierForPrincipal(principal);
        const limits = tierLimits(tier);
        const fileNotFound = (): void => fail(principal, 404, 'file not found');
        const ownedRecord = async (fileId: string): Promise<UserFileRecord | null> => {
          const rec = await catalog.get(fileId);
          return rec && rec.ownerPrincipal === principal ? rec : null;
        };
        const tooLargeError = (size: number): void =>
          failExtra(
            principal,
            413,
            `upload of ${size} bytes exceeds the Default tier upload limit of ${limits.uploadMaxBytes} bytes — Pro uploads are unrestricted`,
            { code: 'UPLOAD_TOO_LARGE', limit: limits.uploadMaxBytes, size, tier: 'default' },
          );
        const fileLimitError = async (): Promise<void> => {
          const count = await catalog.countByOwner(principal);
          failExtra(
            principal,
            409,
            `file limit reached: the Default tier allows at most ${limits.fileLimit} files (you have ${count}) — Pro is unrestricted`,
            { code: 'FILE_LIMIT_REACHED', limit: limits.fileLimit, count, tier: 'default' },
          );
        };

        // GET /api/files — the workspace list (recents order).
        if (seg.length === 0 && method === 'GET') {
          const files = await catalog.listByOwner(principal);
          return reply(principal, 200, { ok: true, tier, limits, count: files.length, files });
        }

        // POST /api/files — create a blank (in-app) file. Created
        // files count toward the Default count cap but have NO size
        // cap (they can grow to anything).
        if (seg.length === 0 && method === 'POST') {
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (e) {
            return fail(principal, 400, bodyError(e));
          }
          const name = (body as { name?: unknown } | undefined)?.name;
          if (typeof name !== 'string' || name.trim().length === 0) {
            return fail(principal, 400, 'name must be a non-empty string');
          }
          // Origin: 'created' by default. 'shared' is accepted for the
          // share-accept flow (shell integration): accepting a shared app
          // materializes the recipient's OWN data copy as a catalog file
          // and the Workspace renders it with the "Shared" tag (contract:
          // received copies are normal catalog entries, origin 'shared').
          // 'upload' is never creatable here — uploads mint their record
          // at complete-upload with a verified storageRef.
          const originRaw = (body as { origin?: unknown } | undefined)?.origin;
          if (originRaw !== undefined && originRaw !== 'created' && originRaw !== 'shared') {
            return fail(principal, 400, "origin must be 'created' or 'shared'");
          }
          const origin = originRaw === 'shared' ? 'shared' : 'created';
          if (tier === 'default') {
            const count = await catalog.countByOwner(principal);
            if (count >= (limits.fileLimit ?? defaultFileLimit())) {
              return fileLimitError();
            }
          }
          const file = await catalog.create({
            fileId: `file-${randomUUID()}`,
            ownerPrincipal: principal,
            name,
            origin,
          });
          return reply(principal, 201, { ok: true, file });
        }

        // POST /api/files/upload-grant — check caps against the
        // DECLARED size + current count BEFORE issuing a staging URL.
        if (seg.length === 1 && seg[0] === 'upload-grant' && method === 'POST') {
          if (!uploadStore) return fail(principal, 503, 'upload store unavailable');
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (e) {
            return fail(principal, 400, bodyError(e));
          }
          const b = (body ?? {}) as { name?: unknown; size?: unknown };
          if (typeof b.name !== 'string' || b.name.trim().length === 0) {
            return fail(principal, 400, 'name must be a non-empty string');
          }
          const format = sourceFormatForFileName(b.name);
          if (format === null) {
            return fail(
              principal,
              400,
              'unsupported file type: only .xlsx, .xls and .csv files can be uploaded',
            );
          }
          if (
            typeof b.size !== 'number' ||
            !Number.isInteger(b.size) ||
            b.size <= 0 ||
            b.size > 256 * 1024 * 1024
          ) {
            return fail(principal, 400, 'size must be a positive integer no larger than 256 MiB');
          }
          const size = b.size;
          if (tier === 'default' && size > (limits.uploadMaxBytes ?? 0)) {
            return tooLargeError(size);
          }
          if (tier === 'default') {
            const count = await catalog.countByOwner(principal);
            if (count >= (limits.fileLimit ?? defaultFileLimit())) {
              return fileLimitError();
            }
          }
          const fileId = `file-${randomUUID()}`;
          const object = uploadObjectKey(principal, fileId, format);
          // The staging PUT's Content-Type MUST equal the signed URL's
          // bound contentType (#96 reopen): bind the format's canonical
          // MIME and return it, so the client sends exactly this header
          // instead of relying on the browser's File.type inference.
          const contentType = canonicalMimeForSourceFormat(format);
          let grant: { url: string; expiresAt: number };
          try {
            grant = await uploadStore.putUrl(object, { principal, maxBytes: size, contentType });
          } catch (e) {
            return fail(
              principal,
              503,
              `upload store unavailable: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          // NO catalog record yet — complete-upload creates it after
          // the bytes land and pass the actual-size re-check.
          return reply(principal, 200, {
            ok: true,
            fileId,
            object,
            upload: { url: grant.url, expiresAt: grant.expiresAt, method: 'PUT', contentType },
          });
        }

        // /api/files/:fileId[/...] routes.
        if (seg.length >= 1) {
          const fileId = seg[0]!;
          if (!/^[A-Za-z0-9._:-]{1,128}$/.test(fileId)) return fileNotFound();

          if (seg.length === 1 && method === 'GET') {
            const rec = await ownedRecord(fileId);
            if (!rec) return fileNotFound();
            return reply(principal, 200, { ok: true, file: rec });
          }

          if (seg.length === 1 && method === 'PATCH') {
            const rec = await ownedRecord(fileId);
            if (!rec) return fileNotFound();
            let body: unknown;
            try {
              body = await readBody(req);
            } catch (e) {
              return fail(principal, 400, bodyError(e));
            }
            const b = (body ?? {}) as {
              name?: unknown;
              hasStoredState?: unknown;
              libraryEntryId?: unknown;
              sizeBytes?: unknown;
            };
            const patch: {
              name?: string;
              hasStoredState?: boolean;
              libraryEntryId?: string | null;
              sizeBytes?: number;
            } = {};
            if (b.name !== undefined) {
              if (typeof b.name !== 'string' || b.name.trim().length === 0) {
                return fail(principal, 400, 'name must be a non-empty string');
              }
              patch.name = b.name;
            }
            if (b.hasStoredState !== undefined) {
              if (typeof b.hasStoredState !== 'boolean') {
                return fail(principal, 400, 'hasStoredState must be a boolean');
              }
              patch.hasStoredState = b.hasStoredState;
            }
            if (b.libraryEntryId !== undefined) {
              if (b.libraryEntryId !== null && typeof b.libraryEntryId !== 'string') {
                return fail(principal, 400, 'libraryEntryId must be a string or null');
              }
              patch.libraryEntryId = b.libraryEntryId as string | null;
            }
            // #105: the catalog size was born 0 at creation and NO save
            // path ever updated it, so every created file listed 0 B
            // forever. The client relays the engine-reported stored
            // size (checkpoint status / library-save entry) through
            // this field; it is validated like any other patch field.
            if (b.sizeBytes !== undefined) {
              if (
                typeof b.sizeBytes !== 'number' ||
                !Number.isSafeInteger(b.sizeBytes) ||
                b.sizeBytes < 0
              ) {
                return fail(principal, 400, 'sizeBytes must be a non-negative integer');
              }
              patch.sizeBytes = b.sizeBytes;
            }
            // No-op guard (#105): a patch that changes nothing must
            // not bump updatedAt — otherwise a redundant size sync on
            // open would rewrite the list's Modified column to the
            // open time instead of the last real change.
            if (
              (patch.name === undefined || patch.name === rec.name) &&
              (patch.hasStoredState === undefined || patch.hasStoredState === rec.hasStoredState) &&
              (patch.libraryEntryId === undefined || patch.libraryEntryId === rec.libraryEntryId) &&
              (patch.sizeBytes === undefined || patch.sizeBytes === rec.sizeBytes)
            ) {
              return reply(principal, 200, { ok: true, file: rec });
            }
            const updated = await catalog.update(fileId, patch);
            if (!updated) return fileNotFound();
            return reply(principal, 200, { ok: true, file: updated });
          }

          if (seg.length === 1 && method === 'DELETE') {
            const rec = await ownedRecord(fileId);
            if (!rec) return fileNotFound();
            if (rec.storageRef && uploadStore) {
              await uploadStore.delete(rec.storageRef.object).catch(() => undefined);
            }
            await catalog.remove(fileId);
            return reply(principal, 200, { ok: true });
          }

          if (seg.length === 2 && seg[1] === 'complete-upload' && method === 'POST') {
            if (!uploadStore) return fail(principal, 503, 'upload store unavailable');
            let body: unknown;
            try {
              body = await readBody(req);
            } catch (e) {
              return fail(principal, 400, bodyError(e));
            }
            const name = (body as { name?: unknown } | undefined)?.name;
            if (typeof name !== 'string' || name.trim().length === 0) {
              return fail(principal, 400, 'name must be a non-empty string');
            }
            const format = sourceFormatForFileName(name);
            if (format === null) {
              return fail(
                principal,
                400,
                'unsupported file type: only .xlsx, .xls and .csv files can be uploaded',
              );
            }
            // Idempotent: an existing record for this fileId+owner
            // IS the completed upload.
            const existing = await ownedRecord(fileId);
            if (existing) return reply(principal, 201, { ok: true, file: existing });
            const anyRec = await catalog.get(fileId);
            if (anyRec) return fileNotFound(); // someone else's fileId
            const object = uploadObjectKey(principal, fileId, format);
            const st = await uploadStore.stat(object);
            if (!st) {
              return failExtra(principal, 404, 'upload not found: no staged bytes for this file', {
                code: 'UPLOAD_NOT_FOUND',
              });
            }
            // ACTUAL size re-check against the CURRENT tier (the
            // tier may have changed since the grant was issued).
            if (tier === 'default' && st.size > (limits.uploadMaxBytes ?? 0)) {
              await uploadStore.delete(object).catch(() => undefined);
              return tooLargeError(st.size);
            }
            if (tier === 'default') {
              const count = await catalog.countByOwner(principal);
              if (count >= (limits.fileLimit ?? defaultFileLimit())) {
                // No orphans: the staged bytes go too.
                await uploadStore.delete(object).catch(() => undefined);
                return fileLimitError();
              }
            }
            const file = await catalog.create({
              fileId,
              ownerPrincipal: principal,
              name,
              origin: 'upload',
              sourceFormat: format,
              sizeBytes: st.size,
              storageRef: { bucket: uploadStore.bucket, object },
            });
            return reply(principal, 201, { ok: true, file });
          }

          if (seg.length === 2 && seg[1] === 'download-grant' && method === 'POST') {
            const rec = await ownedRecord(fileId);
            if (!rec) return fileNotFound();
            if (rec.libraryEntryId) {
              // Save-first bytes live in the engine library store:
              // the same signed-URL pattern as /api/storage/sign.
              const secret = opts.storageSign?.secret ?? opts.engineAccess?.secret;
              if (!secret) {
                return fail(
                  principal,
                  501,
                  'storage signing is not configured on this gateway (ENGINE_ACCESS_SECRET is not set)',
                );
              }
              const { token: st } = issueStorageToken({
                secret,
                entryId: rec.libraryEntryId,
                principal,
                ttlSeconds: opts.storageSign?.ttlSeconds ?? STORAGE_TOKEN_TTL_SECONDS,
              });
              const origin = (
                opts.storageSign?.publicUrl ??
                process.env.ENGINE_PUBLIC_URL ??
                opts.engineAccess?.tiers.standard ??
                routes['/api/engine'] ??
                ''
              ).replace(/\/+$/, '');
              return reply(principal, 200, {
                ok: true,
                url: `${origin}/storage/${rec.libraryEntryId}?st=${st}`,
              });
            }
            if (rec.storageRef) {
              if (!uploadStore) return fail(principal, 503, 'upload store unavailable');
              let grant: { url: string; expiresAt: number };
              try {
                grant = await uploadStore.getUrl(rec.storageRef.object, { principal });
              } catch (e) {
                return fail(
                  principal,
                  503,
                  `upload store unavailable: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              return reply(principal, 200, { ok: true, url: grant.url });
            }
            return failExtra(
              principal,
              409,
              'this file has no stored bytes yet — open it and let it save before downloading',
              { code: 'NO_STORED_BYTES' },
            );
          }
        }

        return fail(principal, 404, `not found: ${path}`);
      }

      // -- app gallery: app + data shares --------------------------------
      // (idea-app-gallery, user-confirmed share design 2026-10-21).
      // Auth + rate limit have already run: sharing requires a signed-in
      // principal. A share is the app WITH a materialized snapshot of
      // its bound data; recipients fetch the package and materialize
      // their OWN bound copies client-side — a recipient never touches
      // the owner's records. Credentials never travel: package
      // validation (service) rejects credential-shaped keys anywhere.
      if (path === '/api/shares' || path.startsWith('/api/shares/')) {
        if (!appShareStore) {
          return fail(principal, 503, 'app sharing unavailable');
        }
        const shares: AppShareStore = appShareStore;
        const seg = path.slice('/api/shares'.length).split('/').filter((s) => s.length > 0);

        // GET /api/shares — "shared by you" (metadata only, no packages).
        if (seg.length === 0 && method === 'GET') {
          const mine = await shares.listByOwner(principal);
          return reply(principal, 200, { ok: true, shares: mine.map(shareSummary) });
        }

        // POST /api/shares — create a share link for an app+data package.
        if (seg.length === 0 && method === 'POST') {
          let body: unknown;
          try {
            body = await readBody(req, 16 * 1024 * 1024);
          } catch (e) {
            return fail(principal, 400, bodyError(e));
          }
          const pkg = (body as { package?: unknown } | undefined)?.package;
          const check = validateAppSharePackage(pkg);
          if (!check.ok) {
            return failExtra(principal, 400, `invalid share package: ${check.errors.join('; ')}`, {
              code: 'INVALID_SHARE_PACKAGE',
              errors: check.errors,
            });
          }
          const rec = await shares.create({
            shareId: `share-${randomUUID()}`,
            ownerPrincipal: principal,
            pkg: pkg as AppSharePackage,
          });
          return reply(principal, 201, { ok: true, share: shareSummary(rec) });
        }

        // GET /api/shares/:shareId — a signed-in recipient fetches the
        // package. Missing OR revoked → the same 404 (no existence leak).
        if (seg.length === 1 && method === 'GET') {
          const rec = await shares.get(seg[0]);
          if (!rec || rec.revokedAt !== null) {
            return fail(principal, 404, 'share not found');
          }
          return reply(principal, 200, { ok: true, share: shareSummary(rec), package: rec.pkg });
        }

        // DELETE /api/shares/:shareId — per-link revoke, owner only
        // (a non-owner gets the same 404 as a missing link).
        if (seg.length === 1 && method === 'DELETE') {
          const ok = await shares.revoke(seg[0], principal);
          if (!ok) return fail(principal, 404, 'share not found');
          return reply(principal, 200, { ok: true });
        }

        return fail(principal, 404, `not found: ${path}`);
      }

      // -- W4: UI-built apps, persisted server-side -------------------
      // (hidden_files/wave-c-fixes/BRIEF.md item W4). Apps built in the
      // app-builder UI persist through this store, keyed by the
      // caller's principal (from the VERIFIED claims — no owner id in
      // the path or body is ever trusted) and bound to the gateway
      // file they were built against. The web client treats the
      // server list as authoritative for the open file and keeps
      // localStorage only as a cache/offline copy. Specs are
      // migrated + validated server-side (normalizeBuiltAppSpec in
      // the store); an invalid spec is a 400, never a stored record.
      if (path === '/api/built-apps' || path.startsWith('/api/built-apps/')) {
        if (!builtAppStore) {
          return fail(principal, 503, 'built-app store unavailable');
        }
        const store: BuiltAppStore = builtAppStore;
        const seg = path
          .slice('/api/built-apps'.length)
          .split('/')
          .filter((s) => s.length > 0);
        const view = (rec: BuiltAppRecord) => ({
          appId: rec.appId,
          fileId: rec.fileId,
          spec: rec.spec,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        });
        const fileIdOf = (raw: unknown): string | null =>
          typeof raw === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : null;

        // GET /api/built-apps?fileId=<id> — the caller's apps for a file.
        if (seg.length === 0 && method === 'GET') {
          const fileId = fileIdOf(url.searchParams.get('fileId') ?? undefined);
          if (!fileId) return fail(principal, 400, 'fileId query parameter is required');
          const records = await store.listByOwnerAndFile(principal, fileId);
          return reply(principal, 200, { ok: true, apps: records.map(view) });
        }

        // POST /api/built-apps { fileId, spec } — create (idempotent
        // upsert by spec.id: a re-upload of the same app, e.g. the
        // migration pass from a second profile, never duplicates).
        if (seg.length === 0 && method === 'POST') {
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (e) {
            return fail(principal, 400, bodyError(e));
          }
          const b = (body ?? {}) as { fileId?: unknown; spec?: unknown };
          const fileId = fileIdOf(b.fileId);
          if (!fileId) return fail(principal, 400, 'fileId must be a valid file id string');
          if (!b.spec || typeof b.spec !== 'object') {
            return fail(principal, 400, 'spec must be an app spec object');
          }
          try {
            const rec = await store.upsert({ ownerPrincipal: principal, fileId, spec: b.spec });
            return reply(principal, 201, { ok: true, app: view(rec) });
          } catch (e) {
            return failExtra(principal, 400, e instanceof Error ? e.message : String(e), {
              code: 'INVALID_APP_SPEC',
            });
          }
        }

        // PUT /api/built-apps/:appId { fileId, spec } — persist spec
        // mutations from the running app (binding growth etc.). The
        // path id must match the spec id.
        if (seg.length === 1 && method === 'PUT') {
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (e) {
            return fail(principal, 400, bodyError(e));
          }
          const b = (body ?? {}) as { fileId?: unknown; spec?: unknown };
          const fileId = fileIdOf(b.fileId);
          if (!fileId) return fail(principal, 400, 'fileId must be a valid file id string');
          if (!b.spec || typeof b.spec !== 'object') {
            return fail(principal, 400, 'spec must be an app spec object');
          }
          if ((b.spec as { id?: unknown }).id !== seg[0]) {
            return fail(principal, 400, 'spec.id must match the app id in the path');
          }
          try {
            const rec = await store.upsert({ ownerPrincipal: principal, fileId, spec: b.spec });
            return reply(principal, 200, { ok: true, app: view(rec) });
          } catch (e) {
            return failExtra(principal, 400, e instanceof Error ? e.message : String(e), {
              code: 'INVALID_APP_SPEC',
            });
          }
        }

        // DELETE /api/built-apps/:appId?fileId=<id> — owner-scoped
        // delete (a non-owner / other-file id gets the same 404 as a
        // missing app).
        if (seg.length === 1 && method === 'DELETE') {
          const fileId = fileIdOf(url.searchParams.get('fileId') ?? undefined);
          if (!fileId) return fail(principal, 400, 'fileId query parameter is required');
          const ok = await store.remove(principal, fileId, seg[0]!);
          if (!ok) return fail(principal, 404, 'app not found');
          return reply(principal, 200, { ok: true });
        }

        return fail(principal, 404, `not found: ${path}`);
      }

      // -- workspace settings (hidden_files/workspace-settings/BRIEF.md)
      // Per-user profile + Icecream Office app settings, persisted in
      // the user settings store (platform-shell.md §4: settings live in
      // the user profile, never in workbook bytes). OWN-SETTINGS ONLY
      // by construction: the record key is the caller's own userId from
      // the VERIFIED claims — no id in the path, so another user's
      // settings are unaddressable, not merely unauthorized. Email is
      // identity (provider-owned): echoed read-only from the verified
      // claims, and a PUT carrying one is rejected, never stored.
      if (path === '/api/settings') {
        if (!userSettingsStore) {
          return fail(principal, 503, 'user settings unavailable');
        }
        const settings: UserSettingsStore = userSettingsStore;
        const userId = principal.startsWith('user:')
          ? principal.slice('user:'.length)
          : principal;
        const view = (rec: {
          user: { displayName: string | null };
          office: { theme: string };
          updatedAt: number;
        }) => ({
          user: {
            displayName: rec.user.displayName,
            email: callerAttrs['email'] ?? null,
            googleName: callerAttrs['name'] ?? null,
          },
          office: { theme: rec.office.theme },
          updatedAt: rec.updatedAt,
        });

        if (method === 'GET') {
          const rec = await settings.get(userId);
          if (!rec) {
            return failExtra(principal, 404, 'no settings saved yet', {
              code: 'SETTINGS_NOT_FOUND',
              // Identity is a property of the CALLER (the verified
              // claims), not of the settings record: echo it even when
              // nothing is saved yet, so a first-run Google user's
              // settings page shows their sign-in email/name instead of
              // a blank (hosted-ux defect D4).
              user: {
                email: callerAttrs['email'] ?? null,
                googleName: callerAttrs['name'] ?? null,
              },
            });
          }
          return reply(principal, 200, { ok: true, settings: view(rec) });
        }

        if (method === 'PUT') {
          let body: unknown;
          try {
            body = await readBody(req);
          } catch (e) {
            return fail(principal, 400, bodyError(e));
          }
          const b = (body ?? {}) as { user?: unknown; office?: unknown; email?: unknown };
          const carriesEmail = (o: unknown): boolean =>
            !!o && typeof o === 'object' && 'email' in (o as Record<string, unknown>);
          if (carriesEmail(b) || carriesEmail(b.user)) {
            return failExtra(
              principal,
              400,
              'email is read-only: it comes from your sign-in provider and cannot be changed here',
              { code: 'EMAIL_READ_ONLY' },
            );
          }
          const patch: UserSettingsPatch = {};
          if (b.user !== undefined) {
            if (!b.user || typeof b.user !== 'object') {
              return fail(principal, 400, 'user must be an object');
            }
            const name = (b.user as { displayName?: unknown }).displayName;
            if (name !== undefined) {
              if (name !== null && typeof name !== 'string') {
                return fail(principal, 400, 'displayName must be a string or null');
              }
              if (typeof name === 'string' && name.trim().length > 120) {
                return fail(principal, 400, 'displayName must be at most 120 characters');
              }
              // Blank clears the override (back to the provider name).
              patch.displayName =
                typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
            }
          }
          if (b.office !== undefined) {
            if (!b.office || typeof b.office !== 'object') {
              return fail(principal, 400, 'office must be an object');
            }
            const theme = (b.office as { theme?: unknown }).theme;
            if (theme !== undefined) {
              if (!isThemeChoice(theme)) {
                return fail(principal, 400, "office.theme must be 'light', 'dark' or 'system'");
              }
              patch.theme = theme;
            }
          }
          const rec = await settings.upsert(userId, patch);
          return reply(principal, 200, { ok: true, settings: view(rec) });
        }

        return fail(principal, 404, `not found: ${path}`);
      }

      // -- account deletion (privacy; workspace-settings brief) --------
      // ONE authenticated action deletes the caller's OWN data across
      // every gateway-owned per-user store: settings record, tier
      // record, file catalog records + their stored upload bytes, and
      // owned app shares (hard delete). Live session leases on the
      // caller's files are released best-effort. Fail-closed: when a
      // core store is unavailable the endpoint 503s rather than
      // half-deleting. Coverage beyond this process (engine library
      // bytes, service-package stores) is enumerated in the track
      // report with reasons.
      if (path === '/api/account' && method === 'DELETE') {
        if (!userSettingsStore || !userTierStore || !userFileCatalog) {
          return fail(principal, 503, 'account deletion unavailable');
        }
        const userId = principal.startsWith('user:')
          ? principal.slice('user:'.length)
          : principal;
        const deleted: Record<string, number | boolean> = {};

        const files = await userFileCatalog.listByOwner(principal);
        let storedObjects = 0;
        for (const f of files) {
          if (f.storageRef && uploadStore) {
            await uploadStore
              .delete(f.storageRef.object)
              .then(() => {
                storedObjects += 1;
              })
              .catch(() => undefined);
          }
          await userFileCatalog.remove(f.fileId);
        }
        deleted['files'] = files.length;
        deleted['storedObjects'] = storedObjects;

        if (appShareStore) {
          const mine = await appShareStore.listByOwner(principal);
          for (const s of mine) await appShareStore.remove(s.shareId);
          deleted['shares'] = mine.length;
        }

        if (builtAppStore) {
          deleted['builtApps'] = await builtAppStore.removeAllForOwner(principal);
        }

        if (fileRegistry) {
          try {
            const now = Date.now();
            let released = 0;
            for (const rec of await fileRegistry.listAll()) {
              if (rec.creatorPrincipal !== principal) continue;
              if (!isLiveOwner(rec, now)) continue;
              if (await fileRegistry.release(rec.fileId, rec.sessionId, rec.ownershipEpoch)) {
                released += 1;
              }
            }
            deleted['sessionsReleased'] = released;
          } catch {
            // Registry hiccup: leases expire on their own TTL anyway.
          }
        }

        deleted['settings'] = await userSettingsStore.remove(userId);
        deleted['tierRecord'] = await userTierStore.deleteRecord(userId);
        return reply(principal, 200, { ok: true, deleted });
      }

      // Route: longest '/api/<name>' prefix wins.
      const routePrefix = Object.keys(routes)
        .filter((p) => path === p || path.startsWith(p + '/'))
        .sort((a, b) => b.length - a.length)[0];
      if (!routePrefix) return fail(principal, 404, `no backend route for ${path}`);
      let backend = routes[routePrefix] as string;
      // Path forwarding: strip the matched prefix (per-bin upstreams
      // serve bare paths) — EXCEPT service-family routes under
      // SERVICE_COMBINED, whose combined-runner upstream dispatches on
      // the full '/api/<name>' prefix (see GatewayOptions.serviceCombined).
      let upstreamPath =
        opts.serviceCombined && SERVICE_FAMILY_ROUTE_SET.has(routePrefix)
          ? path
          : path.slice(routePrefix.length) || '/';

      // Automation owner-routing (triggers program): trigger state
      // (last-run outcomes, the attached runtime) lives in the process
      // that OWNS the file's live session — the engine instance. When
      // the request names a file with a live owner, route it there
      // with the full '/api/automation' path (the engine bin
      // dispatches on it). Files with no live session fall through to
      // the configured automation backend (the service package's
      // detached-CRUD supervisor over the same store).
      let automationRoutedToEngine = false;
      if (routePrefix === '/api/automation' && fileRegistry) {
        const automationFileId = url.searchParams.get('fileId');
        if (automationFileId) {
          try {
            const rec = await fileRegistry.lookup(automationFileId);
            if (rec && isLiveOwner(rec) && typeof rec.ownerEndpoint === 'string' && rec.ownerEndpoint) {
              backend = rec.ownerEndpoint;
              upstreamPath = path;
              automationRoutedToEngine = true;
            }
          } catch {
            // Registry hiccup: the configured backend still serves
            // the request (detached CRUD semantics).
          }
        }
      }

      // Timeout class (Item D): EVERY engine route gets the 600s
      // engine upstream class (ENGINE_UPSTREAM_TIMEOUT_MS) — see the
      // constant's comment for the full rationale. The routes that
      // forced earlier per-route carve-outs are all engine routes and
      // stay covered: /load + /load/stream (P95 build ~40s of server
      // work, Cycle 10 Phase 2), GET /snapshot (P95 snapshot ~27s
      // before the first byte; the 30s default 502'd every P95 save
      // at 30,012ms, Cycle 10 finisher), /download (defect 2c: tens
      // of seconds of serialization before the first byte, and it
      // JOINS any in-flight checkpoint), /library-save + /library
      // (Cycle 10 closure, same serialization class), /read (W20:
      // reads PEND on the engine's build gate and queue behind the
      // build's synchronous event-loop block — the W18 gate's 5× 502
      // per P95 open). The checkpoint-class routes those carve-outs
      // missed — /session/release (checkpoint + evict),
      // /session/rehydrate, /load/storage-ref, /ops + /execute
      // (barrier checkpoint / save-pin queue inside the sequencer) —
      // are covered by the same route-level class instead of a new
      // enumeration that would drift again. Non-engine routes keep
      // the 30s fail-fast default below.
      const isEngineRoute = routePrefix === '/api/engine';
      // Buffer the body so it can be forwarded exactly once. The engine
      // /load endpoint carries whole file bytes (base64): it gets a
      // file-sized cap (Cycle 10, Phase 2). Every other endpoint keeps
      // the 1MB fail-closed cap, except the extras-carrying save-class
      // routes below.
      const isEngineFileLoad = path === '/api/engine/load' || path === '/api/engine/load/stream';
      // The engine download's POST body carries only small session
      // extras (client UI metadata + defined names), capped well above
      // the 1MB default but far below file size (defect 2c).
      const isEngineDownload = path === '/api/engine/download';
      // Library save (Cycle 10 closure): a small session-extras request
      // body — same body cap as the download.
      const isEngineLibrarySave = path === '/api/engine/library-save';
      // Session-extras sync carries the SAME extras payload the save
      // routes have always accepted (sheet styles expand over the used
      // range — multi-MB on P95-class workbooks), so it shares the
      // download/save body cap rather than the 1MB default.
      const isEngineSessionExtras = path === '/api/engine/session-extras';
      // Agent chat turns park on HITL asks for up to ~4 minutes by
      // design (see AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS): /message gets
      // the long timeout; every other agent route keeps the 30s
      // default (they are quick config/pending/watch calls, and a hung
      // one should still fail fast).
      const isAgentMessage =
        (path === '/api/agent/message' || path === '/api/agent/message/stream') && method === 'POST';
      const bodyCap = isEngineFileLoad
        ? LOAD_MAX_BODY_BYTES
        : isEngineDownload || isEngineLibrarySave || isEngineSessionExtras
          ? DOWNLOAD_MAX_BODY_BYTES
          : MAX_BODY_BYTES;
      let bodyBuf: Buffer | null = null;
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
          total += buf.length;
          if (total > bodyCap) {
            req.resume();
            return fail(principal, 413, `request body exceeds ${bodyCap} bytes`);
          }
          chunks.push(buf);
        }
        if (chunks.length > 0) bodyBuf = Buffer.concat(chunks);
      } catch {
        return fail(principal, 400, 'failed to read request body');
      }

      // Service-family Cloud Run identity (Leg 1): the service
      // package's Cloud Run service grants run.invoker only to the
      // gateway SA, so a service-family request still headed for its
      // CONFIGURED service upstream carries a Google ID token
      // (audience = that upstream's origin) in Authorization — see
      // GatewayOptions.serviceIdTokenProvider. Automation requests
      // owner-routed to an ENGINE are excluded (engines verify their
      // own signed tokens; a Google ID token there would be parsed
      // as a malformed engine-access token), as is /api/engine
      // itself. A null token (no metadata server — local dev) leaves
      // the request exactly as it has always been proxied.
      let serviceIdToken: string | null = null;
      if (SERVICE_FAMILY_ROUTE_SET.has(routePrefix) && !automationRoutedToEngine) {
        try {
          serviceIdToken = await serviceIdTokenProvider(new URL(backend).origin);
        } catch {
          serviceIdToken = null;
        }
      }

      // #108: gateway-attached signed binding for agent-service
      // calls naming a file. Only /api/agent POSTs with a JSON body
      // carrying a well-formed string fileId resolve a binding; all
      // other proxied calls are unchanged (the header is inert for
      // routes that do not read it, and proxy() strips any
      // client-supplied binding on every route).
      let agentBinding: string | undefined;
      if (routePrefix === '/api/agent' && method === 'POST' && bodyBuf) {
        let agentFileId: string | null = null;
        try {
          const parsed = JSON.parse(bodyBuf.toString('utf8')) as { fileId?: unknown };
          if (
            typeof parsed.fileId === 'string' &&
            /^[A-Za-z0-9._:-]{1,128}$/.test(parsed.fileId)
          ) {
            agentFileId = parsed.fileId;
          }
        } catch {
          agentFileId = null;
        }
        if (agentFileId) {
          const resolved = await resolveAgentBinding(principal, agentFileId);
          if (resolved.status === 'error') {
            return fail(principal, resolved.code, resolved.message);
          }
          if (resolved.status === 'bound') agentBinding = resolved.binding;
        }
      }

      await proxy(principal, backend, upstreamPath, url.search, method, req, res, bodyBuf, {
        timeoutMs: isEngineRoute
          ? ENGINE_UPSTREAM_TIMEOUT_MS
          : isAgentMessage
            ? AGENT_MESSAGE_UPSTREAM_TIMEOUT_MS
            : DEFAULT_UPSTREAM_TIMEOUT_MS,
        ...(serviceIdToken ? { serviceIdToken } : {}),
        ...(agentBinding ? { agentBinding } : {}),
      });
      logAudit(method, path, principal, res.statusCode, Date.now() - started);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        fail('anonymous', 500, `gateway error: ${msg}`);
      } catch {
        // Response already in flight; nothing more to do.
      }
    }
  };

  const listener = Object.assign(handle, { auditLog: audit, limiter });
  return listener;
}

function bodyError(e: unknown): string {
  if (e instanceof SyntaxError) return 'malformed JSON body';
  const msg = e instanceof Error ? e.message : String(e);
  return msg;
}

async function proxy(
  principal: string,
  backend: string,
  upstreamPath: string,
  search: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  bodyBuf: Buffer | null,
  opts: { timeoutMs?: number; serviceIdToken?: string; agentBinding?: string } = {},
): Promise<void> {
  const target = new URL(upstreamPath + search, backend);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k === 'host' || k === 'content-length') continue;
    headers[k] = v;
  }
  headers['x-principal'] = principal; // gateway-verified identity for the service
  // #108: a client-supplied binding header must never reach the
  // service (it would be a forgery vector — the service trusts ONLY
  // a gateway-signed binding). Strip it unconditionally on every
  // proxied route, then set the gateway's own when one was resolved
  // for this call.
  delete headers[AGENT_BINDING_HEADER];
  if (opts.agentBinding) headers[AGENT_BINDING_HEADER] = opts.agentBinding;
  // Cloud Run platform identity for the service-family upstream
  // (Leg 1): replaces the caller's gateway JWT in Authorization —
  // Cloud Run consumes that slot for its run.invoker check and the
  // service reads identity from x-principal above, never from the
  // gateway JWT. Set only when the caller resolved a token; absent
  // (local dev) the forwarded headers are unchanged.
  if (opts.serviceIdToken) headers['authorization'] = `Bearer ${opts.serviceIdToken}`;
  if (bodyBuf) headers['content-length'] = String(bodyBuf.length);

  await new Promise<void>((resolve) => {
    // Production upstreams are https (Cloud Run); local ones are http.
    // http.request throws on an https: target, so pick the transport by
    // the target's protocol — the rest of the exchange is identical.
    const up = (target.protocol === 'https:' ? https.request : http.request)(
      target,
      { method, headers, timeout: opts.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS },
      (upRes) => {
        applyCors(res);
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k)) continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        // Streamed, never buffered: pipe flushes chunks as the backend
        // emits them — this is what lets /api/engine/load/stream's NDJSON
        // chunks (meta → sheet rows → built) reach the browser
        // progressively (Cycle 10 Phase 4).
        upRes.pipe(res);
        upRes.on('end', () => resolve());
      },
    );
    up.on('timeout', () => {
      up.destroy(new Error('backend timeout'));
    });
    up.on('error', () => {
      // Backend unreachable / refused: 502. The gateway never leaks the
      // backend's error text (it may carry internal detail).
      if (!res.headersSent) {
        applyCors(res);
        sendError(res, 502, 'backend unavailable');
      } else {
        res.end();
      }
      resolve();
    });
    if (bodyBuf) up.write(bodyBuf);
    up.end();
  });
}

/** Start a gateway on `port` (helper for tests and startAllLocal). */
export function listen(listener: GatewayListener, port: number, host = '127.0.0.1'): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(listener);
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
