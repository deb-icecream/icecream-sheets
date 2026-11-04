import type { Persistence } from '@icecream-sheets/service';
/** Env var overriding the gateway data directory. */
export declare const GATEWAY_DATA_DIR_ENV = "ICECREAM_DATA_DIR";
/**
 * Resolve (and create) the gateway data directory. Reads the env var on
 * every call so tests can redirect it before the first persistence use.
 */
export declare function gatewayDataDir(): string;
/** One file per key: sanitized name + hash suffix (no collisions). */
export declare function persistenceFileFor(dir: string, key: string): string;
/**
 * Build a file-backed Persistence rooted at `dir` (default:
 * gatewayDataDir()). Each save() rewrites the whole key file atomically.
 */
export declare function filePersistence(dir?: string): Persistence;
