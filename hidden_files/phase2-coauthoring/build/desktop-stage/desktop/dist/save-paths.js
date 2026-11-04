"use strict";
/**
 * Save-path hardening (GAP-10).
 *
 * `file:saveBytes` accepts a `suggestedPath` from the renderer and writes
 * bytes there. A compromised renderer could hand over an arbitrary absolute
 * path and make the main process write anywhere on disk. The shell therefore
 * only honors a suggested path when it lives inside the directory of the
 * last file the user explicitly picked or saved (via a native dialog or an
 * OS-triggered open). Anything else falls back to the Save dialog.
 *
 * Pure functions (no Electron imports) so they can be unit-tested with node.
 */
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
exports.trustedDirOf = trustedDirOf;
exports.isPathInsideDir = isPathInsideDir;
exports.resolveSaveTarget = resolveSaveTarget;
const path = __importStar(require("node:path"));
/** Directory of a file the user explicitly chose, resolved to an absolute path. */
function trustedDirOf(filePath) {
    return path.resolve(path.dirname(filePath));
}
/**
 * True when `candidate` resolves to a file inside `trustedDir` (or is
 * `trustedDir` itself — harmless). False when there is no trusted dir yet,
 * or the candidate escapes it (e.g. via `..` segments or an absolute path
 * elsewhere). Resolution first, so `../` traversal cannot smuggle a path out.
 */
function isPathInsideDir(candidate, trustedDir) {
    if (!trustedDir)
        return false;
    const resolved = path.resolve(candidate);
    const dir = path.resolve(trustedDir);
    return resolved === dir || resolved.startsWith(dir + path.sep);
}
function resolveSaveTarget(suggestedPath, trustedDir) {
    if (suggestedPath && isPathInsideDir(suggestedPath, trustedDir)) {
        return { mode: 'direct', path: suggestedPath };
    }
    return { mode: 'dialog' };
}
//# sourceMappingURL=save-paths.js.map