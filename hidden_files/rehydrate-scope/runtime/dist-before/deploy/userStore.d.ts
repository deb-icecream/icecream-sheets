/**
 * Product layer — per-user tier store + file catalog
 * (hidden_files/product-layer/CONTRACT.md §Tiers, §File catalog).
 *
 * Two small durable stores, both following the fileRegistry.ts /
 * sessionStore.ts adapter posture:
 *   local — JSON file under USER_STORE_DIR (default
 *     <sessionDataDir>/user-store), guarded by a cross-process
 *     lockfile mutex; atomic tmp+rename writes; IO errors THROW.
 *   memory — interface-level fake for unit tests.
 *   prod — Firestore-shaped structural adapter (collections
 *     `icecream_user_tiers` / `icecream_user_files`). Factories FAIL
 *     CLOSED in prod mode (USER_STORE=prod) without an injected
 *     Firestore client — never a silent local fallback.
 *
 * Tiers: exactly 'default' | 'pro'. Default caps come from named,
 * env-configurable constants (CONTRACT §Tiers). Pending promotions by
 * email are consumed at first record creation (resolveTier with that
 * email): an operator can promote an email before the user has ever
 * signed in, and the first login lands at the promoted tier.
 */
import { type FirestoreLike } from './sessionStore.js';
export type Tier = 'default' | 'pro';
/** P75 workbook size (bytes) — the Default-tier upload cap default. */
export declare const DEFAULT_UPLOAD_MAX_BYTES = 1285214;
/** Default-tier workspace file-count cap default. */
export declare const DEFAULT_FILE_LIMIT = 10;
/** TIER_DEFAULT_UPLOAD_MAX_BYTES override. */
export declare function defaultUploadMaxBytes(env?: NodeJS.ProcessEnv): number;
/** TIER_DEFAULT_FILE_LIMIT override. */
export declare function defaultFileLimit(env?: NodeJS.ProcessEnv): number;
/** Limits view for a tier: null = unrestricted (pro). */
export declare function tierLimits(tier: Tier, env?: NodeJS.ProcessEnv): {
    uploadMaxBytes: number | null;
    fileLimit: number | null;
};
export declare function isTier(x: unknown): x is Tier;
/** USER_STORE: 'local' (default) | 'prod' (Firestore). */
export declare function userStoreProvider(env?: NodeJS.ProcessEnv): 'local' | 'prod';
/** USER_STORE_DIR: local adapter root (default <sessionDataDir>/user-store). */
export declare function userStoreDir(env?: NodeJS.ProcessEnv): string;
export interface UserTierRecord {
    userId: string;
    email?: string;
    tier: Tier;
    createdAt: number;
    updatedAt: number;
}
export interface UserTierStore {
    /**
     * The tier for a user, creating the record on first sight (default
     * tier, unless a pending promotion exists for the supplied email —
     * consumed here) and backfilling the email on an existing record.
     */
    resolveTier(input: {
        userId: string;
        email?: string;
    }): Promise<Tier>;
    /** The stored record, or null when the user was never seen. */
    getRecord(userId: string): Promise<UserTierRecord | null>;
    /**
     * Promote/demote by email: updates the record when one carries that
     * email (returns it); otherwise records a PENDING promotion consumed
     * at that email's first resolveTier (returns null).
     */
    setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null>;
    /** Promote/demote by userId: updates or creates the record. */
    setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord>;
    /** The pending promotion tier for an email, or null. */
    getPendingByEmail(email: string): Promise<Tier | null>;
    /**
     * Account deletion: remove the user's record entirely, plus any
     * pending promotion keyed by the record's email (a later sign-in
     * must land as a FRESH account — a surviving pending promotion
     * would silently re-tier it). Returns true when a record existed.
     */
    deleteRecord(userId: string): Promise<boolean>;
}
export declare class MemoryUserTierStore implements UserTierStore {
    private readonly records;
    private readonly pending;
    resolveTier(input: {
        userId: string;
        email?: string;
    }): Promise<Tier>;
    getRecord(userId: string): Promise<UserTierRecord | null>;
    setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null>;
    setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord>;
    getPendingByEmail(email: string): Promise<Tier | null>;
    deleteRecord(userId: string): Promise<boolean>;
}
export declare class LocalUserTierStore implements UserTierStore {
    private readonly file;
    private readonly lock;
    constructor(dir: string);
    private readAll;
    resolveTier(input: {
        userId: string;
        email?: string;
    }): Promise<Tier>;
    getRecord(userId: string): Promise<UserTierRecord | null>;
    setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null>;
    setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord>;
    getPendingByEmail(email: string): Promise<Tier | null>;
    deleteRecord(userId: string): Promise<boolean>;
}
export declare class FirestoreUserTierStore implements UserTierStore {
    private readonly db;
    constructor(db: FirestoreLike);
    private doc;
    getRecord(userId: string): Promise<UserTierRecord | null>;
    getPendingByEmail(email: string): Promise<Tier | null>;
    resolveTier(input: {
        userId: string;
        email?: string;
    }): Promise<Tier>;
    setTierByEmail(email: string, tier: Tier): Promise<UserTierRecord | null>;
    setTierByUserId(userId: string, tier: Tier): Promise<UserTierRecord>;
    deleteRecord(userId: string): Promise<boolean>;
}
/**
 * Build the tier store for the configured provider. 'prod' REQUIRES an
 * injected Firestore client — fail closed, never a local fallback.
 */
export declare function createUserTierStore(env?: NodeJS.ProcessEnv, opts?: {
    firestoreDb?: FirestoreLike;
    dir?: string;
}): UserTierStore;
export type SourceFormat = 'xlsx' | 'csv' | 'xls';
/**
 * Derive the source format from a filename's extension, case-insensitive.
 * Returns null for anything that is not a supported upload type.
 * ('.xls' = legacy BIFF: the engine parses it through SheetJS — sweep
 * finding F-2; note '.xlsx' must be tested before '.xls' would matter —
 * endsWith('.xls') is false for '.xlsx', so order is safe.)
 */
export declare function sourceFormatForFileName(name: string): SourceFormat | null;
export interface UserFileRecord {
    fileId: string;
    ownerPrincipal: string;
    name: string;
    /** Format of the bytes the user originally uploaded ('xlsx' for created-in-app files). */
    sourceFormat: SourceFormat;
    /**
     * How the file entered the owner's workspace: uploaded, created
     * in-app, or received by accepting a share (a copy of someone
     * else's app + data placed in the recipient's workspace — the
     * share/accept flow itself belongs to the gallery layer; the
     * catalog only records the resulting copy like any other entry).
     */
    origin: 'upload' | 'created' | 'shared';
    sizeBytes: number;
    storageRef: {
        bucket: string;
        object: string;
    } | null;
    libraryEntryId: string | null;
    hasStoredState: boolean;
    createdAt: number;
    updatedAt: number;
    lastOpenedAt: number;
}
export type UserFilePatch = Partial<Pick<UserFileRecord, 'name' | 'hasStoredState' | 'libraryEntryId' | 'sizeBytes' | 'storageRef' | 'lastOpenedAt'>>;
export interface UserFileCatalog {
    create(input: {
        fileId: string;
        ownerPrincipal: string;
        name: string;
        origin: 'upload' | 'created' | 'shared';
        sourceFormat?: SourceFormat;
        sizeBytes?: number;
        storageRef?: {
            bucket: string;
            object: string;
        } | null;
        libraryEntryId?: string | null;
        hasStoredState?: boolean;
    }): Promise<UserFileRecord>;
    get(fileId: string): Promise<UserFileRecord | null>;
    /** Owner's files, most recently opened first (lastOpenedAt DESC). */
    listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]>;
    update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null>;
    remove(fileId: string): Promise<boolean>;
    countByOwner(ownerPrincipal: string): Promise<number>;
    /** Stamp lastOpenedAt = now (recents order). */
    touchOpened(fileId: string): Promise<UserFileRecord | null>;
}
export declare class MemoryUserFileCatalog implements UserFileCatalog {
    private readonly records;
    create(input: Parameters<UserFileCatalog['create']>[0]): Promise<UserFileRecord>;
    get(fileId: string): Promise<UserFileRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]>;
    update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null>;
    remove(fileId: string): Promise<boolean>;
    countByOwner(ownerPrincipal: string): Promise<number>;
    touchOpened(fileId: string): Promise<UserFileRecord | null>;
}
export declare class LocalUserFileCatalog implements UserFileCatalog {
    private readonly file;
    private readonly lock;
    constructor(dir: string);
    private readAll;
    create(input: Parameters<UserFileCatalog['create']>[0]): Promise<UserFileRecord>;
    get(fileId: string): Promise<UserFileRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]>;
    update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null>;
    remove(fileId: string): Promise<boolean>;
    countByOwner(ownerPrincipal: string): Promise<number>;
    touchOpened(fileId: string): Promise<UserFileRecord | null>;
}
export declare class FirestoreUserFileCatalog implements UserFileCatalog {
    private readonly db;
    constructor(db: FirestoreLike);
    private doc;
    create(input: Parameters<UserFileCatalog['create']>[0]): Promise<UserFileRecord>;
    get(fileId: string): Promise<UserFileRecord | null>;
    listByOwner(ownerPrincipal: string): Promise<UserFileRecord[]>;
    update(fileId: string, patch: UserFilePatch): Promise<UserFileRecord | null>;
    remove(fileId: string): Promise<boolean>;
    countByOwner(ownerPrincipal: string): Promise<number>;
    touchOpened(fileId: string): Promise<UserFileRecord | null>;
}
/**
 * Build the file catalog for the configured provider. 'prod' REQUIRES
 * an injected Firestore client — fail closed, never a local fallback.
 */
export declare function createUserFileCatalog(env?: NodeJS.ProcessEnv, opts?: {
    firestoreDb?: FirestoreLike;
    dir?: string;
}): UserFileCatalog;
export type ThemeChoice = 'light' | 'dark' | 'system';
/** App-settings default (brief: theme defaults to System). */
export declare const DEFAULT_THEME_CHOICE: ThemeChoice;
export declare function isThemeChoice(x: unknown): x is ThemeChoice;
export interface UserSettingsRecord {
    userId: string;
    /** Profile scope. displayName null = no override (provider name). */
    user: {
        displayName: string | null;
    };
    /** Icecream Office scope (product-agnostic, suite-wide). */
    office: {
        theme: ThemeChoice;
    };
    createdAt: number;
    updatedAt: number;
}
export interface UserSettingsPatch {
    /** Profile display-name override; null clears the override. */
    displayName?: string | null;
    /** Office theme choice. */
    theme?: ThemeChoice;
}
export interface UserSettingsStore {
    /** The stored record, or null when the user never saved settings. */
    get(userId: string): Promise<UserSettingsRecord | null>;
    /** Create-or-merge: only the patched fields change. */
    upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord>;
    /** Account deletion. Returns true when a record existed. */
    remove(userId: string): Promise<boolean>;
}
export declare class MemoryUserSettingsStore implements UserSettingsStore {
    private readonly records;
    get(userId: string): Promise<UserSettingsRecord | null>;
    upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord>;
    remove(userId: string): Promise<boolean>;
}
export declare class LocalUserSettingsStore implements UserSettingsStore {
    private readonly file;
    private readonly lock;
    constructor(dir: string);
    private readAll;
    get(userId: string): Promise<UserSettingsRecord | null>;
    upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord>;
    remove(userId: string): Promise<boolean>;
}
export declare class FirestoreUserSettingsStore implements UserSettingsStore {
    private readonly db;
    constructor(db: FirestoreLike);
    private doc;
    get(userId: string): Promise<UserSettingsRecord | null>;
    upsert(userId: string, patch: UserSettingsPatch): Promise<UserSettingsRecord>;
    remove(userId: string): Promise<boolean>;
}
/**
 * Build the settings store for the configured provider (the family
 * switch, USER_STORE). 'prod' REQUIRES an injected Firestore client —
 * fail closed, never a local fallback.
 */
export declare function createUserSettingsStore(env?: NodeJS.ProcessEnv, opts?: {
    firestoreDb?: FirestoreLike;
    dir?: string;
}): UserSettingsStore;
/** Validated prod configuration for the user-store family. */
export interface ProdUserConfig {
    projectId: string;
    databaseId?: string;
}
/**
 * USER_STORE=prod requires GCP_PROJECT_ID (FIRESTORE_DATABASE_ID
 * optional). Throws fail-closed BEFORE any client work when the
 * project is not configured — the share-store posture.
 */
export declare function prodUserConfig(env?: NodeJS.ProcessEnv): ProdUserConfig;
/** The three USER_STORE-family stores, all over ONE Firestore client. */
export interface ProdUserStores {
    userTierStore: UserTierStore;
    userFileCatalog: UserFileCatalog;
    userSettingsStore: UserSettingsStore;
}
/**
 * Construct the prod (Firestore) user stores: validates config first
 * (fail closed when GCP_PROJECT_ID is missing), then loads the
 * official @google-cloud/firestore client. Credentials resolve through
 * the client's own ADC discovery (the Cloud Run service account in
 * production; the operator's deployer credentials for set-tier).
 */
export declare function createProdUserStores(env?: NodeJS.ProcessEnv): Promise<ProdUserStores>;
/**
 * Construct ONLY the prod tier store (the set-tier operator tool's
 * target): same validation + client load as createProdUserStores.
 */
export declare function createProdUserTierStore(env?: NodeJS.ProcessEnv): Promise<UserTierStore>;
