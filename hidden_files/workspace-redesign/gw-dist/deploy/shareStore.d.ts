import { type FirestoreLike } from './sessionStore.js';
import type { AppSharePackage } from '@icecream-sheets/service';
export interface AppShareRecord {
    shareId: string;
    ownerPrincipal: string;
    appName: string;
    sourceSheet: string;
    rowCount: number;
    colCount: number;
    createdAt: number;
    revokedAt: number | null;
    /** The shared app + data snapshot (service AppSharePackage shape). */
    pkg: AppSharePackage;
}
/** Metadata view for "shared by you" lists — never carries the package. */
export type AppShareSummary = Omit<AppShareRecord, 'pkg'>;
export declare function shareSummary(rec: AppShareRecord): AppShareSummary;
export interface AppShareStore {
    create(input: {
        shareId: string;
        ownerPrincipal: string;
        pkg: AppSharePackage;
    }): Promise<AppShareRecord>;
    /** The record (revoked included) or null. Callers enforce revoked. */
    get(shareId: string): Promise<AppShareRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]>;
    /** Owner-only revoke. Returns false when missing or not the owner's. */
    revoke(shareId: string, ownerPrincipal: string): Promise<boolean>;
    /**
     * HARD delete (account deletion): the record — package data and
     * all — is gone, not merely revoked. Returns false when missing.
     * Ownership is the CALLER's job (it enumerates via listByOwner).
     */
    remove(shareId: string): Promise<boolean>;
}
export declare class MemoryAppShareStore implements AppShareStore {
    private readonly records;
    create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord>;
    get(shareId: string): Promise<AppShareRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]>;
    revoke(shareId: string, ownerPrincipal: string): Promise<boolean>;
    remove(shareId: string): Promise<boolean>;
}
export declare class LocalAppShareStore implements AppShareStore {
    private readonly file;
    private readonly lock;
    constructor(dir: string);
    private readAll;
    private writeAll;
    create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord>;
    get(shareId: string): Promise<AppShareRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]>;
    revoke(shareId: string, ownerPrincipal: string): Promise<boolean>;
    remove(shareId: string): Promise<boolean>;
}
/** Firestore collection holding app-share documents. */
export declare const APP_SHARES_COLLECTION = "icecream_app_shares";
/**
 * Firestore single-document ceiling enforced client-side (the same
 * 1,048,576-byte hard limit firestoreMetadata.ts enforces): a share
 * whose serialized record exceeds it fails loudly at create() time.
 */
export declare const APP_SHARE_DOC_CAP_BYTES = 1048576;
/** Document id for a share id: sha256 hex (always a legal doc id). */
export declare function shareDocId(shareId: string): string;
export declare class FirestoreAppShareStore implements AppShareStore {
    private readonly db;
    constructor(db: FirestoreLike);
    private doc;
    create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord>;
    get(shareId: string): Promise<AppShareRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]>;
    revoke(shareId: string, ownerPrincipal: string): Promise<boolean>;
    remove(shareId: string): Promise<boolean>;
}
export declare function shareStoreProvider(env?: NodeJS.ProcessEnv): 'local' | 'prod';
export declare function shareStoreDir(env?: NodeJS.ProcessEnv): string;
/** Validated prod configuration for the share store. */
export interface ProdShareConfig {
    projectId: string;
    databaseId?: string;
}
/**
 * SHARE_STORE=prod requires GCP_PROJECT_ID (FIRESTORE_DATABASE_ID
 * optional). Throws fail-closed BEFORE any client work when the
 * project is not configured — the MCP runner-config posture.
 */
export declare function prodShareConfig(env?: NodeJS.ProcessEnv): ProdShareConfig;
/**
 * Construct the prod (Firestore) share store: validates config first
 * (fail closed when GCP_PROJECT_ID is missing), then loads the
 * official @google-cloud/firestore client through a non-literal
 * dynamic import — the package is an optional prod dependency, and a
 * missing package is a fail-closed startup error, never a silent
 * fallback (sessionStore.loadProdClients posture).
 */
export declare function createProdAppShareStore(env?: NodeJS.ProcessEnv): Promise<AppShareStore>;
/**
 * Construct the share store from env. Prod mode REQUIRES an injected
 * Firestore client (mirroring createFileRegistry / createUserTierStore:
 * the async client bootstrap lives in createProdAppShareStore, which
 * the gateway bin awaits) — without one this throws rather than
 * silently landing shares on local disk in production.
 */
export declare function createAppShareStore(env?: NodeJS.ProcessEnv, opts?: {
    firestoreDb?: FirestoreLike;
}): AppShareStore;
