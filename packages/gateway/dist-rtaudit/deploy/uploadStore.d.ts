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
import { type StorageLike } from './sessionStore.js';
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
export declare const UPLOAD_TOKEN_TTL_SECONDS = 600;
/** Issue a signed upload token. `nowMs` is injectable for tests. */
export declare function issueUploadToken(opts: {
    secret: string;
    op: UploadOp;
    object: string;
    principal: string;
    maxBytes?: number;
    ttlSeconds?: number;
    nowMs?: number;
}): {
    token: string;
    claims: UploadTokenClaims;
};
/**
 * Verify an upload token: structure, HMAC signature (constant-time),
 * expiry, and — when given — op / object / principal scope. Throws
 * EngineAccessError with a machine-readable reason.
 */
export declare function verifyUploadToken(token: string, secret: string, opts?: {
    op?: UploadOp;
    object?: string;
    principal?: string;
    nowMs?: number;
}): UploadTokenClaims;
/** Object key for an upload: uploads/<sha256(ownerPrincipal)[0:16]>/<fileId>.xlsx */
export declare function uploadObjectKey(ownerPrincipal: string, fileId: string): string;
/** UPLOAD_BUCKET: the upload bucket name. Default 'icecream-uploads'. */
export declare function uploadBucket(env?: NodeJS.ProcessEnv): string;
/** UPLOAD_STORE_DIR: local adapter root (default <sessionDataDir>/uploads). */
export declare function uploadStoreDir(env?: NodeJS.ProcessEnv): string;
/** UPLOAD_STORE: 'local' (default) | 'prod' (GCS). */
export declare function uploadStoreProvider(env?: NodeJS.ProcessEnv): 'local' | 'prod';
export interface UploadObjectStore {
    bucket: string;
    /** Public base the staging URLs are built on (mutable: bins/tests set it once the listen port is known). */
    publicBaseUrl: string;
    /** HMAC secret for staging tokens (mutable for the same reason). */
    tokenSecret?: string;
    put(object: string, bytes: Uint8Array): Promise<void>;
    get(object: string): Promise<Uint8Array | null>;
    stat(object: string): Promise<{
        size: number;
    } | null>;
    delete(object: string): Promise<void>;
    putUrl(object: string, opts: {
        principal: string;
        maxBytes?: number;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
    getUrl(object: string, opts: {
        principal: string;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
}
interface BaseOpts {
    bucket?: string;
    publicBaseUrl?: string;
    tokenSecret?: string;
}
declare abstract class StagingUrlStore {
    bucket: string;
    publicBaseUrl: string;
    tokenSecret?: string;
    constructor(opts: BaseOpts);
    putUrl(object: string, opts: {
        principal: string;
        maxBytes?: number;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
    getUrl(object: string, opts: {
        principal: string;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
}
export declare class MemoryUploadObjectStore extends StagingUrlStore implements UploadObjectStore {
    private readonly objects;
    constructor(opts?: BaseOpts);
    put(object: string, bytes: Uint8Array): Promise<void>;
    get(object: string): Promise<Uint8Array | null>;
    stat(object: string): Promise<{
        size: number;
    } | null>;
    delete(object: string): Promise<void>;
}
export declare class LocalUploadObjectStore extends StagingUrlStore implements UploadObjectStore {
    private readonly root;
    constructor(dir: string, opts?: BaseOpts);
    private pathFor;
    put(object: string, bytes: Uint8Array): Promise<void>;
    get(object: string): Promise<Uint8Array | null>;
    stat(object: string): Promise<{
        size: number;
    } | null>;
    delete(object: string): Promise<void>;
}
/** The slice of a GCS file handle the upload store uses beyond StorageLike. */
export interface UploadStorageFileLike {
    save(data: Buffer, opts?: Record<string, unknown>): Promise<unknown>;
    download(): Promise<[Buffer]>;
    getMetadata(): Promise<[Record<string, unknown>]>;
    delete(): Promise<unknown>;
    getSignedUrl?(opts: Record<string, unknown>): Promise<[string] | string>;
}
export interface UploadStorageLike {
    bucket(name: string): {
        file(path: string): UploadStorageFileLike;
    };
}
export declare class GcsUploadObjectStore extends StagingUrlStore implements UploadObjectStore {
    private readonly storage;
    constructor(storage: UploadStorageLike, opts?: BaseOpts);
    private file;
    put(object: string, bytes: Uint8Array): Promise<void>;
    get(object: string): Promise<Uint8Array | null>;
    stat(object: string): Promise<{
        size: number;
    } | null>;
    delete(object: string): Promise<void>;
    putUrl(object: string, opts: {
        principal: string;
        maxBytes?: number;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
    getUrl(object: string, opts: {
        principal: string;
        ttlSeconds?: number;
    }): Promise<{
        url: string;
        expiresAt: number;
    }>;
}
export declare function createUploadObjectStore(env?: NodeJS.ProcessEnv, opts?: {
    dir?: string;
    bucket?: string;
    publicBaseUrl?: string;
    tokenSecret?: string;
    storage?: UploadStorageLike | StorageLike;
}): UploadObjectStore;
/** Whether the local upload root exists (diagnostics). */
export declare function localUploadRootExists(env?: NodeJS.ProcessEnv): boolean;
export {};
