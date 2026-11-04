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
}
export declare class MemoryAppShareStore implements AppShareStore {
    private readonly records;
    create(input: Parameters<AppShareStore['create']>[0]): Promise<AppShareRecord>;
    get(shareId: string): Promise<AppShareRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<AppShareRecord[]>;
    revoke(shareId: string, ownerPrincipal: string): Promise<boolean>;
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
}
export declare function shareStoreProvider(env?: NodeJS.ProcessEnv): 'local' | 'prod';
export declare function shareStoreDir(env?: NodeJS.ProcessEnv): string;
/**
 * Construct the share store from env. FAILS CLOSED in prod mode: no
 * durable prod adapter exists yet, and a share store must never
 * silently land on local disk in production.
 */
export declare function createAppShareStore(env?: NodeJS.ProcessEnv): AppShareStore;
