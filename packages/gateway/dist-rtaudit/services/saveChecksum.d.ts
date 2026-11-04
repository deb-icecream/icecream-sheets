import type { EngineHost } from '@icecream-sheets/engine';
type BulkCell = ReturnType<EngineHost['bulkReadback']>[number];
/** The checksum over an already-materialized bulk readback. */
export declare function checksumFromBulk(bulk: BulkCell[]): string;
export declare function bulkStateChecksum(host: EngineHost, principal: string): string;
export {};
