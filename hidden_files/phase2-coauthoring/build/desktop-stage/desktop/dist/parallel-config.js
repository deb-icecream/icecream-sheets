"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDesktopMtThreshold = resolveDesktopMtThreshold;
exports.resolveParallelWorkerCount = resolveParallelWorkerCount;
exports.logicalCpuCount = logicalCpuCount;
/**
 * Parallel-recalculation pool sizing for the desktop shell (track 13).
 *
 * The desktop's main-process EngineHost runs explicit recalcs through the
 * engine's worker pool (node:worker_threads via the engine's
 * NodeWorkerBackend) instead of the single-threaded serial path. This
 * module resolves the pool size; it is deliberately pure (no Electron
 * imports) so it can be unit-tested.
 *
 * Configuration: ICECREAM_PARALLEL_WORKERS overrides the default. There is
 * no desktop settings store yet — platform-shell.md §4 says settings belong
 * in the user profile, so when one appears this default should become a
 * per-user preference and this constant its fallback.
 */
const os = __importStar(require("node:os"));
const engine_1 = require("@icecream-sheets/engine");
/**
 * The MT cell-count threshold for the desktop shell (Cycle 10 Phase 3):
 * the ONE FLAG's cell-count side (shouldEnableParallelRecalc) on the
 * main-process engine. Canonical env var ICECREAM_MT_CELL_COUNT_THRESHOLD
 * (shared with the web routing layer's hybridRecalcConfigFromEnv — one
 * threshold, one name); ICECREAM_PARALLEL_CELL_THRESHOLD is honored as a
 * legacy alias inside the engine's resolver. Desktop has no settings
 * store yet (platform-shell.md §4); when one appears, the settings field
 * wins under the env override the same way the web seam does.
 */
function resolveDesktopMtThreshold(env = process.env) {
    return (0, engine_1.resolveParallelCellThreshold)(env);
}
/**
 * Resolve the parallel-recalculation worker count.
 *
 * Default: logical CPUs minus one (one core left for the UI / main thread),
 * minimum 1. The engine clamps the effective count to the partition count
 * anyway, and normalizeParallelOptions() caps it at MAX_WORKERS (64), so an
 * oversized value is harmless.
 *
 * @param env process.env (injectable for tests)
 */
function resolveParallelWorkerCount(env = process.env) {
    const raw = env['ICECREAM_PARALLEL_WORKERS'];
    if (raw !== undefined && raw !== '') {
        const n = Math.floor(Number(raw));
        if (Number.isInteger(n) && n >= 1)
            return n;
        // Malformed override: ignore it and fall through to the default rather
        // than disabling parallelism by accident.
    }
    return Math.max(1, logicalCpuCount() - 1);
}
/** Logical CPU count, defensively resolved (minimum 1). */
function logicalCpuCount() {
    try {
        // availableParallelism() exists on Node 16+ (and Electron's Node).
        const n = os.availableParallelism();
        if (Number.isInteger(n) && n >= 1)
            return n;
        const cpus = os.cpus();
        if (Array.isArray(cpus) && cpus.length >= 1)
            return cpus.length;
    }
    catch {
        // fall through
    }
    return 1;
}
//# sourceMappingURL=parallel-config.js.map