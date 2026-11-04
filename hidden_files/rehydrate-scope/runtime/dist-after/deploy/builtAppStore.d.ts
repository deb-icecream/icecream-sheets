import { type FirestoreLike } from './sessionStore.js';
import { type AppSpec } from '@icecream-sheets/service';
export interface BuiltAppRecord {
    appId: string;
    ownerPrincipal: string;
    fileId: string;
    /** The validated, migrated AppSpec (its `fileId` matches fileId). */
    spec: AppSpec;
    createdAt: number;
    updatedAt: number;
}
export interface BuiltAppStore {
    /**
     * Create-or-replace one app for (owner, fileId). The spec is
     * migrated + validated server-side; an invalid spec throws.
     * The record's file binding is the route's fileId — a spec whose
     * own fileId disagrees is re-stamped to the route binding.
     */
    upsert(input: {
        ownerPrincipal: string;
        fileId: string;
        spec: unknown;
    }): Promise<BuiltAppRecord>;
    /** One app, owner-scoped; null when missing or not the owner's. */
    get(ownerPrincipal: string, fileId: string, appId: string): Promise<BuiltAppRecord | null>;
    /** The owner's apps bound to one file, oldest first. */
    listByOwnerAndFile(ownerPrincipal: string, fileId: string): Promise<BuiltAppRecord[]>;
    /** Everything the owner has (account deletion). Oldest first. */
    listByOwner(ownerPrincipal: string): Promise<BuiltAppRecord[]>;
    /** Owner-scoped delete. False when missing or not the owner's. */
    remove(ownerPrincipal: string, fileId: string, appId: string): Promise<boolean>;
    /** Hard-delete every record of an owner (account deletion). */
    removeAllForOwner(ownerPrincipal: string): Promise<number>;
}
/** Migrate + validate an unknown value into the spec to store. */
export declare function normalizeBuiltAppSpec(raw: unknown, fileId: string): AppSpec;
export declare class MemoryBuiltAppStore implements BuiltAppStore {
    private readonly records;
    upsert(input: Parameters<BuiltAppStore['upsert']>[0]): Promise<BuiltAppRecord>;
    get(ownerPrincipal: string, fileId: string, appId: string): Promise<BuiltAppRecord | null>;
    listByOwnerAndFile(ownerPrincipal: string, fileId: string): Promise<BuiltAppRecord[]>;
    listByOwner(ownerPrincipal: string): Promise<BuiltAppRecord[]>;
    remove(ownerPrincipal: string, fileId: string, appId: string): Promise<boolean>;
    removeAllForOwner(ownerPrincipal: string): Promise<number>;
}
export declare class LocalBuiltAppStore implements BuiltAppStore {
    private readonly file;
    private readonly lock;
    constructor(dir: string);
    private readAll;
    private writeAll;
    upsert(input: Parameters<BuiltAppStore['upsert']>[0]): Promise<BuiltAppRecord>;
    get(ownerPrincipal: string, fileId: string, appId: string): Promise<BuiltAppRecord | null>;
    listByOwnerAndFile(ownerPrincipal: string, fileId: string): Promise<BuiltAppRecord[]>;
    listByOwner(ownerPrincipal: string): Promise<BuiltAppRecord[]>;
    remove(ownerPrincipal: string, fileId: string, appId: string): Promise<boolean>;
    removeAllForOwner(ownerPrincipal: string): Promise<number>;
}
export declare const BUILT_APPS_COLLECTION = "icecream_built_apps";
export declare const BUILT_APP_DOC_CAP_BYTES = 1048576;
export declare function builtAppDocId(ownerPrincipal: string, fileId: string, appId: string): string;
export declare class FirestoreBuiltAppStore implements BuiltAppStore {
    private readonly db;
    constructor(db: FirestoreLike);
    private doc;
    upsert(input: Parameters<BuiltAppStore['upsert']>[0]): Promise<BuiltAppRecord>;
    get(ownerPrincipal: string, fileId: string, appId: string): Promise<BuiltAppRecord | null>;
    listByOwnerAndFile(ownerPrincipal: string, fileId: string): Promise<BuiltAppRecord[]>;
    listByOwner(ownerPrincipal: string): Promise<BuiltAppRecord[]>;
    remove(ownerPrincipal: string, fileId: string, appId: string): Promise<boolean>;
    removeAllForOwner(ownerPrincipal: string): Promise<number>;
}
export declare function builtAppStoreProvider(env?: NodeJS.ProcessEnv): 'local' | 'prod';
export declare function builtAppStoreDir(env?: NodeJS.ProcessEnv): string;
/**
 * Construct the built-app store from env. Prod mode REQUIRES an
 * injected Firestore client — without one this throws rather than
 * silently landing apps on local disk in production (fail closed,
 * the createAppShareStore / createUserTierStore posture).
 */
export declare function createBuiltAppStore(env?: NodeJS.ProcessEnv, opts?: {
    firestoreDb?: FirestoreLike;
}): BuiltAppStore;
