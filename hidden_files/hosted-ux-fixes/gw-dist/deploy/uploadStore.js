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
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { EngineAccessError } from './engineAccess.js';
import { sessionDataDir } from './sessionStore.js';
/** Default upload-token lifetime: 600 s (10 min). */
export const UPLOAD_TOKEN_TTL_SECONDS = 600;
function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64url');
}
function sign(payloadPart, secret) {
    return createHmac('sha256', secret).update(payloadPart, 'utf8').digest('base64url');
}
/** Issue a signed upload token. `nowMs` is injectable for tests. */
export function issueUploadToken(opts) {
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const claims = {
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
export function verifyUploadToken(token, secret, opts = {}) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
        throw new EngineAccessError('malformed');
    }
    const [payloadPart, sigPart] = parts;
    const expected = sign(payloadPart, secret);
    const a = Buffer.from(sigPart, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new EngineAccessError('bad-signature');
    }
    let claims;
    try {
        claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    }
    catch {
        throw new EngineAccessError('malformed');
    }
    if (!claims ||
        claims.v !== 1 ||
        (claims.op !== 'put' && claims.op !== 'get') ||
        typeof claims.object !== 'string' ||
        typeof claims.principal !== 'string') {
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
export function uploadObjectKey(ownerPrincipal, fileId, format = 'xlsx') {
    const hash = createHash('sha256').update(ownerPrincipal, 'utf8').digest('hex').slice(0, 16);
    return `uploads/${hash}/${fileId}.${format}`;
}
/** UPLOAD_BUCKET: the upload bucket name. Default 'icecream-uploads'. */
export function uploadBucket(env = process.env) {
    const b = (env.UPLOAD_BUCKET ?? '').trim();
    return b !== '' ? b : 'icecream-uploads';
}
/** UPLOAD_STORE_DIR: local adapter root (default <sessionDataDir>/uploads). */
export function uploadStoreDir(env = process.env) {
    const fromEnv = (env.UPLOAD_STORE_DIR ?? '').trim();
    return fromEnv !== '' ? fromEnv : join(sessionDataDir(env), 'uploads');
}
/** UPLOAD_STORE: 'local' (default) | 'prod' (GCS). */
export function uploadStoreProvider(env = process.env) {
    const v = (env.UPLOAD_STORE ?? '').trim().toLowerCase();
    return v === 'prod' || v === 'gcs' ? 'prod' : 'local';
}
function stagingUrl(publicBaseUrl, tokenSecret, op, object, opts) {
    if (!tokenSecret) {
        throw new Error('upload store: no upload token secret configured (ENGINE_ACCESS_SECRET) — cannot issue a staging URL (fail closed)');
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
class StagingUrlStore {
    bucket;
    publicBaseUrl;
    tokenSecret;
    constructor(opts) {
        this.bucket = opts.bucket ?? 'icecream-uploads';
        this.publicBaseUrl = opts.publicBaseUrl ?? 'http://127.0.0.1:8100';
        this.tokenSecret = opts.tokenSecret;
    }
    async putUrl(object, opts) {
        return stagingUrl(this.publicBaseUrl, this.tokenSecret, 'put', object, opts);
    }
    async getUrl(object, opts) {
        return stagingUrl(this.publicBaseUrl, this.tokenSecret, 'get', object, opts);
    }
}
// ---------------------------------------------------------------------------
// Memory adapter
// ---------------------------------------------------------------------------
export class MemoryUploadObjectStore extends StagingUrlStore {
    objects = new Map();
    constructor(opts = {}) {
        super(opts);
    }
    async put(object, bytes) {
        this.objects.set(object, new Uint8Array(bytes));
    }
    async get(object) {
        const b = this.objects.get(object);
        return b ? new Uint8Array(b) : null;
    }
    async stat(object) {
        const b = this.objects.get(object);
        return b ? { size: b.length } : null;
    }
    async delete(object) {
        this.objects.delete(object);
    }
}
// ---------------------------------------------------------------------------
// Local (filesystem) adapter
// ---------------------------------------------------------------------------
export class LocalUploadObjectStore extends StagingUrlStore {
    root;
    constructor(dir, opts = {}) {
        super(opts);
        mkdirSync(dir, { recursive: true });
        this.root = resolve(dir);
    }
    pathFor(object) {
        const p = resolve(join(this.root, object));
        if (p !== this.root && !p.startsWith(this.root + sep)) {
            throw new Error(`upload store: object key escapes the store root: ${object}`);
        }
        return p;
    }
    async put(object, bytes) {
        const target = this.pathFor(object);
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, target);
    }
    async get(object) {
        try {
            return readFileSync(this.pathFor(object));
        }
        catch (e) {
            if (e?.code === 'ENOENT')
                return null;
            throw e;
        }
    }
    async stat(object) {
        try {
            return { size: statSync(this.pathFor(object)).size };
        }
        catch (e) {
            if (e?.code === 'ENOENT')
                return null;
            throw e;
        }
    }
    async delete(object) {
        try {
            unlinkSync(this.pathFor(object));
        }
        catch (e) {
            if (e?.code !== 'ENOENT')
                throw e;
        }
    }
}
export class GcsUploadObjectStore extends StagingUrlStore {
    storage;
    constructor(storage, opts = {}) {
        super(opts);
        this.storage = storage;
    }
    file(object) {
        return this.storage.bucket(this.bucket).file(object);
    }
    async put(object, bytes) {
        await this.file(object).save(Buffer.from(bytes));
    }
    async get(object) {
        try {
            const [bytes] = await this.file(object).download();
            return new Uint8Array(bytes);
        }
        catch {
            return null;
        }
    }
    async stat(object) {
        try {
            const [meta] = await this.file(object).getMetadata();
            const size = Number(meta.size);
            return Number.isFinite(size) ? { size } : null;
        }
        catch {
            return null;
        }
    }
    async delete(object) {
        try {
            await this.file(object).delete();
        }
        catch {
            // Already gone.
        }
    }
    async putUrl(object, opts) {
        const f = this.file(object);
        if (typeof f.getSignedUrl === 'function') {
            const ttl = opts.ttlSeconds ?? UPLOAD_TOKEN_TTL_SECONDS;
            const expiresAt = Date.now() + ttl * 1000;
            const signedOpts = {
                version: 'v4',
                action: 'write',
                expires: expiresAt,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            };
            // maxBytes enforcement via content-length-range when expressible:
            // the signed-URL options shape varies by client version; the
            // complete-step actual-size check enforces regardless.
            if (opts.maxBytes !== undefined)
                signedOpts['contentLengthRange'] = { max: opts.maxBytes };
            const out = await f.getSignedUrl(signedOpts);
            const url = Array.isArray(out) ? out[0] : out;
            return { url, expiresAt };
        }
        return super.putUrl(object, opts);
    }
    async getUrl(object, opts) {
        const f = this.file(object);
        if (typeof f.getSignedUrl === 'function') {
            const ttl = opts.ttlSeconds ?? UPLOAD_TOKEN_TTL_SECONDS;
            const expiresAt = Date.now() + ttl * 1000;
            const out = await f.getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });
            const url = Array.isArray(out) ? out[0] : out;
            return { url, expiresAt };
        }
        return super.getUrl(object, opts);
    }
}
// ---------------------------------------------------------------------------
// Factory (fails closed in prod without an injected client)
// ---------------------------------------------------------------------------
export function createUploadObjectStore(env = process.env, opts = {}) {
    const bucket = opts.bucket ?? uploadBucket(env);
    if (uploadStoreProvider(env) === 'prod') {
        if (!opts.storage) {
            throw new Error('upload store: UPLOAD_STORE=prod requires a Cloud Storage client (credentials) — refusing to fall back to a local store (fail closed)');
        }
        return new GcsUploadObjectStore(opts.storage, {
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
export function localUploadRootExists(env = process.env) {
    return existsSync(uploadStoreDir(env));
}
