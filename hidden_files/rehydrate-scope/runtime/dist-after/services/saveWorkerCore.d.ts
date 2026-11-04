import type { SaveWorkerJob, SaveWorkerResult } from './saveWorkerSpawn.js';
export declare class SaveChecksumError extends Error {
    readonly code = "checksum-mismatch";
    constructor(message: string);
}
export declare function runSaveJob(job: SaveWorkerJob, outPath: string, log?: (m: string) => void): Promise<SaveWorkerResult>;
