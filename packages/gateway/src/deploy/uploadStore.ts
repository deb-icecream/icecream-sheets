/**
 * Product layer — upload object store + upload tokens
 * (hidden_files/product-layer/CONTRACT.md §Upload object store).
 *
 * Bytes-only store for staged workbook uploads. The gateway issues a
 * short-lived signed staging URL (putUrl), the client PUTs the file
 * bytes DIRECTLY to that URL (the token IS the auth — the staging
 * routes bypass the JWT pipeline), and complete-upload then stats the
 * object and re-checks the ACTUAL size against the tier caps before a
 * catalog record is created.
 *
 * Upload tokens mirror the engineAccess storage-token HMAC scheme
 * exactly: token = base64url(payloadJson) "." base64url(HMAC-SHA256(
 * secret, payloadPart)); payload { v:1, op:'put'|'get', object,
 * principal, maxBytes?, exp } (exp: unix seconds). The secret is the
 * gateway's ENGINE_ACCESS_SECRET (storageSign secret path).
 *
 * Adapters (sessionStore.ts posture):
 *   local — files under UPLOAD_STORE_DIR (default
 *     <sessionDataDir>/uploads); putUrl/getUrl return GATEWAY STAGING
 *     URLs under the injected public base.
 *   memory — interface-level fake for unit tests (same URL scheme).
 *   prod — GCS via a narrow structural StorageLike; the factory FAILS
 *     CLOSED in prod mode (UPLOAD_STORE=prod) without an injected
 *     client. putUrl uses a v4 signed URL when the client supports
 *     getSignedUrl, else the staging URL (the complete-step
 *     actual-size check always enforces caps regardless).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { EngineAccessError } from './engineAccess.js';
import { sessionDataDir, type StorageLike } from './sessionStore.js';

// ---------------------------------------------------------------------------
// Upload tokens (engineAccess HMAC scheme)
// ---------------------------------------------------------------------------

export type UploadOp = 'put' | 'get';

export interface UploadTokenClaims {
  v: 1;
  op: UploadOp;
  object: string;
  principal: string;
  maxBytes?: number;
  /** Expiry, unix seconds. */
  exp: number;
}

/** Default upload-token lifetime: 600 s (10 min). */
export const UPLOAD_TOKEN_TTL_SECONDS = 600;

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(payloadPart: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}

/** Issue a signed upload token. `nowMs` is injectable for tests. */
export function issueUploadToken(opts: {
  secret: string;
  op: UploadOp;
  object: string;
  principal: string;
  maxBytes?: number;
  ttlSeconds?: number;
  nowMs?: number;
}): { token: string; claims: UploadTokenClaims } {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const claims: UploadTokenClaims = {
    v: 1,
    op: opts.op,
    object: opts.object,
    principal: opts.principal,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    exp: nowSec + (opts.ttlSeconds ?? UPLOAD_TOKEN_TTL_SECONDS),
  };
  const payloadPart = b64urlEncode(JSON.stringify(claims));
  return { token: `${payloadPart}.${sign(payloadPart, opts.secret)}`, claims };
}

/**
 * Verify an upload token: structure, HMAC signature (constant-time),
 * expiry, and — when given — op / object / principal scope. Throws
 * EngineAccessError with a machine-readable reason.
 */
export function verifyUploadToken(
  token: string,
  secret: string,
  opts: { op?: UploadOp; object?: string; principal?: string; nowMs?: number } = {},
): UploadTokenClaims {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new EngineAccessError('malformed');
  }
  const [payloadPart, sigPart] = parts as [string, string];
  const expected = sign(payloadPart, secret);
  const a = Buffer.from(sigPart, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new EngineAccessError('bad-signature');
  }
  let claims: UploadTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as UploadTokenClaims;
  } catch {
    throw new EngineAccessError('malformed');
  }
  if (
    !claims ||
    claims.v !== 1 ||
    (claims.op !== 'put' && claims.op !== 'get') ||
    typeof claims.object !== 'string' ||
    typeof claims.principal !== 'string'
  ) {
    throw new EngineAccessError('unsupported-version');
  }
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof claims.exp !== 'number' || nowSec >= claims.exp) {
    throw new EngineAccessError('expired');
  }
  if (opts.op !== undefined && claims.op !== opts.op) {
    throw new EngineAccessError('wrong-session');
  }
  if (opts.object !== undefined && claims.object !== opts.object) {
    throw new EngineAccessError('wrong-session');
  }
  if (opts.principal !== undefined && claims.principal !== opts.principal) {
    throw new EngineAccessError('wrong-principal');
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Object keys + env config
// ---------------------------------------------------------------------------

/** Object key for an upload: uploads/<sha256(ownerPrincipal)[0:16]>/<fileId>.<format> */
export function uploadObjectKey(
  ownerPrincipal: string,
  fileId: string,
  format: 'xlsx' | 'csv' | 'xls' = 'xlsx',
): string {
  const hash = createHash('sha256').update(ownerPrincipal, 'utf8').digest('hex').slice(0, 16);
  return `uploads/${hash}/${fileId}.${format}`;
}

/** UPLOAD_BUCKET: the upload bucket name. Default 'icecream-uploads'. */
export function uploadBucket(env: NodeJS.ProcessEnv = process.env): string {
  const b = (env.UPLOAD_BUCKET ?? '').trim();
  return b !== '' ? b : 'icecream-uploads';
}

/** UPLOAD_STORE_DIR: local adapter root (default <sessionDataDir>/uploads). */
export function uploadStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.UPLOAD_STORE_DIR ?? '').trim();
  return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'uploads');
}

/** UPLOAD_STORE: 'local' (default) | 'prod' (GCS). */
export function uploadStoreProvider(env: NodeJS.ProcessEnv = process.env): 'local' | 'prod' {
  const v = (env.UPLOAD_STORE ?? '').trim().toLowerCase();
  return v === 'prod' || v === 'gcs' ? 'prod' : 'local';
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface UploadObjectStore {
  bucket: string;
  /** Public base the staging URLs are built on (mutable: bins/tests set it once the listen port is known). */
  publicBaseUrl: string;
  /** HMAC secret for staging tokens (mutable for the same reason). */
  tokenSecret?: string;
  put(object: string, bytes: Uint8Array): Promise<void>;
  get(object: string): Promise<Uint8Array | null>;
  stat(object: string): Promise<{ size: number } | null>;
  delete(object: string): Promise<void>;
  putUrl(
    object: string,
    opts: { principal: string; maxBytes?: number; ttlSeconds?: number; contentType?: string },
  ): Promise<{ url: string; expiresAt: number }>;
  getUrl(
    object: string,
    opts: { principal: string; ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: number }>;
}

function stagingUrl(
  publicBaseUrl: string,
  tokenSecret: string | undefined,
  op: UploadOp,
  object: string,
  opts: { principal: string; maxBytes?: number; ttlSeconds?: number },
): { url: string; expiresAt: number } {
  if (!tokenSecret) {
    throw new Error(
      'upload store: no upload token secret configured (ENGINE_ACCESS_SECRET) — cannot issue a staging URL (fail closed)',
    );
  }
  const { token, claims } = issueUploadToken({
    secret: tokenSecret,
    op,
    object,
    principal: opts.principal,
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
  });
  const base = publicBaseUrl.replace(/\/+$/, '');
  return {
    url: `${base}/uploads/stage/${encodeURIComponent(object)}?ut=${token}`,
    expiresAt: claims.exp * 1000,
  };
}

interface BaseOpts {
  bucket?: string;
  publicBaseUrl?: string;
  tokenSecret?: string;
}

abstract class StagingUrlStore {
  bucket: string;
  publicBaseUrl: string;
  tokenSecret?: string;
  constructor(opts: BaseOpts) {
    this.bucket = opts.bucket ?? 'icecream-uploads';
    this.publicBaseUrl = opts.publicBaseUrl ?? 'http://127.0.0.1:8100';
    this.tokenSecret = opts.tokenSecret;
  }
  async putUrl(
    object: string,
    opts: { principal: string; maxBytes?: number; ttlSeconds?: number; contentType?: string },
  ): Promise<{ url: string; expiresAt: number }> {
    return stagingUrl(this.publicBaseUrl, this.tokenSecret, 'put', object, opts);
  }
  async getUrl(
    object: string,
    opts: { principal: string; ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    return stagingUrl(this.publicBaseUrl, this.tokenSecret, 'get', object, opts);
  }
}

// ---------------------------------------------------------------------------
// Memory adapter
// ---------------------------------------------------------------------------

export class MemoryUploadObjectStore extends StagingUrlStore implements UploadObjectStore {
  private readonly objects = new Map<string, Uint8Array>();
  constructor(opts: BaseOpts = {}) {
    super(opts);
  }
  async put(object: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(object, new Uint8Array(bytes));
  }
  async get(object: string): Promise<Uint8Array | null> {
    const b = this.objects.get(object);
    return b ? new Uint8Array(b) : null;
  }
  async stat(object: string): Promise<{ size: number } | null> {
    const b = this.objects.get(object);
    return b ? { size: b.length } : null;
  }
  async delete(object: string): Promise<void> {
    this.objects.delete(object);
  }
}

// ---------------------------------------------------------------------------
// Local (filesystem) adapter
// ---------------------------------------------------------------------------

export class LocalUploadObjectStore extends StagingUrlStore implements UploadObjectStore {
  private readonly root: string;
  constructor(dir: string, opts: BaseOpts = {}) {
    super(opts);
    mkdirSync(dir, { recursive: true });
    this.root = resolve(dir);
  }

  private pathFor(object: string): string {
    const p = resolve(join(this.root, object));
    if (p !== this.root && !p.startsWith(this.root + sep)) {
      throw new Error(`upload store: object key escapes the store root: ${object}`);
    }
    return p;
  }

  async put(object: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(object);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }
  async get(object: string): Promise<Uint8Array | null> {
    try {
      return readFileSync(this.pathFor(object));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  }
  async stat(object: string): Promise<{ size: number } | null> {
    try {
      return { size: statSync(this.pathFor(object)).size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(object: string): Promise<void> {
    try {
      unlinkSync(this.pathFor(object));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Production adapter (GCS) — structural StorageLike
// ---------------------------------------------------------------------------

/** The slice of a GCS file handle the upload store uses beyond StorageLike. */
export interface UploadStorageFileLike {
  save(data: Buffer, opts?: Record<string, unknown>): Promise<unknown>;
  download(): Promise<[Buffer]>;
  getMetadata(): Promise<[Record<string, unknown>]>;
  delete(): Promise<unknown>;
  getSignedUrl?(opts: Record<string, unknown>): Promise<[string] | string>;
}
export interface UploadStorageLike {
  bucket(name: string): { file(path: string): UploadStorageFileLike };
}

export class GcsUploadObjectStore extends StagingUrlStore implements UploadObjectStore {
  constructor(
    private readonly storage: UploadStorageLike,
    opts: BaseOpts = {},
  ) {
    super(opts);
  }

  private file(object: string): UploadStorageFileLike {
    return this.storage.bucket(this.bucket).file(object);
  }

  async put(object: string, bytes: Uint8Array): Promise<void> {
    await this.file(object).save(Buffer.from(bytes));
  }
  async get(object: string): Promise<Uint8Array | null> {
    try {
      const [bytes] = await this.file(object).download();
      return new Uint8Array(bytes);
    } catch {
      return null;
    }
  }
  async stat(object: string): Promise<{ size: number } | null> {
    try {
      const [meta] = await this.file(object).getMetadata();
      const size = Number((meta as { size?: unknown }).size);
      return Number.isFinite(size) ? { size } : null;
    } catch {
      return null;
    }
  }
  async delete(object: string): Promise<void> {
    try {
      await this.file(object).delete();
    } catch {
      // Already gone.
    }
  }

  override async putUrl(
    object: string,
    opts: { principal: string; maxBytes?: number; ttlSeconds?: number; contentType?: string },
  ): Promise<{ url: string; expiresAt: number }> {
    const f = this.file(object);
    if (typeof f.getSignedUrl === 'function') {
      const ttl = opts.ttlSeconds ?? UPLOAD_TOKEN_TTL_SECONDS;
      const expiresAt = Date.now() + ttl * 1000;
      const signedOpts: Record<string, unknown> = {
        version: 'v4',
        action: 'write',
        expires: expiresAt,
        // Bound Content-Type MUST equal the header the browser sends on
        // the PUT (#96 reopen: the old code hardcoded the xlsx MIME for
        // every format, so .csv/.xls PUTs could never match). The grant
        // binds the format's canonical MIME and returns it to the client.
        contentType:
          opts.contentType ??
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
      // maxBytes enforcement via content-length-range when expressible:
      // the signed-URL options shape varies by client version; the
      // complete-step actual-size check enforces regardless.
      if (opts.maxBytes !== undefined) signedOpts['contentLengthRange'] = { max: opts.maxBytes };
      const out = await f.getSignedUrl(signedOpts);
      const url = Array.isArray(out) ? out[0]! : out;
      return { url, expiresAt };
    }
    return super.putUrl(object, opts);
  }

  override async getUrl(
    object: string,
    opts: { principal: string; ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    const f = this.file(object);
    if (typeof f.getSignedUrl === 'function') {
      const ttl = opts.ttlSeconds ?? UPLOAD_TOKEN_TTL_SECONDS;
      const expiresAt = Date.now() + ttl * 1000;
      const out = await f.getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });
      const url = Array.isArray(out) ? out[0]! : out;
      return { url, expiresAt };
    }
    return super.getUrl(object, opts);
  }
}

// ---------------------------------------------------------------------------
// Factory (fails closed in prod without an injected client)
// ---------------------------------------------------------------------------

export function createUploadObjectStore(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    dir?: string;
    bucket?: string;
    publicBaseUrl?: string;
    tokenSecret?: string;
    storage?: UploadStorageLike | StorageLike;
  } = {},
): UploadObjectStore {
  const bucket = opts.bucket ?? uploadBucket(env);
  if (uploadStoreProvider(env) === 'prod') {
    if (!opts.storage) {
      throw new Error(
        'upload store: UPLOAD_STORE=prod requires a Cloud Storage client (credentials) — refusing to fall back to a local store (fail closed)',
      );
    }
    return new GcsUploadObjectStore(opts.storage as UploadStorageLike, {
      bucket,
      publicBaseUrl: opts.publicBaseUrl,
      tokenSecret: opts.tokenSecret,
    });
  }
  return new LocalUploadObjectStore(opts.dir ?? uploadStoreDir(env), {
    bucket,
    publicBaseUrl: opts.publicBaseUrl,
    tokenSecret: opts.tokenSecret,
  });
}

/** Whether the local upload root exists (diagnostics). */
export function localUploadRootExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(uploadStoreDir(env));
}
