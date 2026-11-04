"use strict";
/**
 * Renderer entry-point resolution.
 *
 * The desktop shell is a thin host: the real UI lives in apps/web/dist
 * (built by the web app phase). In development that directory sits next to
 * this package (apps/desktop/dist -> apps/web/dist/index.html). Once
 * packaged, electron-builder places bundled files under resourcesPath, so
 * several candidate layouts are probed and the first existing file wins.
 *
 * Pure function (no Electron imports) so it can be unit-tested with node.
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
exports.resolveRendererIndex = resolveRendererIndex;
exports.findLaunchFilePath = findLaunchFilePath;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/**
 * Return the absolute path of the renderer index.html, or null when the web
 * build is missing (the caller then shows the fallback page).
 */
function resolveRendererIndex(lookup) {
    const candidates = [
        // Workspace dev layout: apps/desktop/dist -> apps/web/dist/index.html
        path.resolve(lookup.distDir, '..', '..', 'web', 'dist', 'index.html'),
    ];
    if (lookup.resourcesPath) {
        candidates.push(
        // Packaged layout: electron-builder puts everything in app.asar, so
        // the file is at <resources>/app.asar/web/dist/index.html. The
        // literal `app.asar` segment is required — Electron's fs patching only
        // resolves inside asar archives when the path names the archive.
        path.join(lookup.resourcesPath, 'app.asar', 'web', 'dist', 'index.html'), 
        // Legacy/alternate layouts, kept as fallbacks.
        path.join(lookup.resourcesPath, 'app', 'web', 'dist', 'index.html'), path.join(lookup.resourcesPath, 'web', 'dist', 'index.html'));
    }
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        }
        catch {
            // Candidate does not exist — try the next one.
        }
    }
    return null;
}
/**
 * Spreadsheet extensions the desktop shell opens (mirrors the
 * `file:pickOpen` dialog filters).
 */
const SPREADSHEET_EXTS = new Set(['.xlsx', '.csv', '.tsv', '.ods']);
/**
 * GAP-4: find a workbook path in a process launch argv.
 *
 * Double-clicking a workbook in Explorer launches the packaged app with the
 * file as argv[1] (argv[0] is the exe). In dev (`electron . file.xlsx`),
 * argv[1] is the `.` project dir and the file lands in argv[2]. Flags
 * (`--foo`) are skipped; the first remaining argument with a spreadsheet
 * extension wins. Returns undefined when no workbook path is present.
 */
function findLaunchFilePath(argv) {
    for (const arg of argv.slice(1)) {
        if (arg.startsWith('-'))
            continue;
        if (SPREADSHEET_EXTS.has(path.extname(arg).toLowerCase()))
            return arg;
    }
    return undefined;
}
//# sourceMappingURL=paths.js.map