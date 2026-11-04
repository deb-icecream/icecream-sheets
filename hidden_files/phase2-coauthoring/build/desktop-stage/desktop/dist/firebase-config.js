"use strict";
/**
 * Firebase project config seam (Cycle 9: Firebase Google login — desktop).
 *
 * The Firebase project config is NOT available yet, so nothing is hardcoded
 * here — no API keys, no project ids. The config is loaded from, in order:
 *
 *   1. ICECREAM_FIREBASE_CONFIG  — JSON string in the environment
 *      (e.g. {"apiKey":"…","authDomain":"….firebaseapp.com","projectId":"…"}).
 *   2. FIREBASE_CONFIG_PATH      — path to a JSON file with the same shape.
 *   3. <userData>/firebase.config.json — the Electron userData directory
 *      (per-user; never checked into the repo).
 *
 * When none of them yields a valid config, loadFirebaseConfig() throws a
 * FirebaseNotConfiguredError with a clear message naming every location
 * that was checked. The login window renders that message instead of a
 * sign-in button, and the auth IPC fails closed with the same message.
 *
 * Only the public web-config fields are needed (they are public by design
 * in Firebase — the apiKey is not a secret). Google is the ONLY provider;
 * there is deliberately no username/password anywhere in this flow.
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
exports.FirebaseNotConfiguredError = void 0;
exports.loadFirebaseConfig = loadFirebaseConfig;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
/** Thrown when no Firebase config can be found. Carries the fix. */
class FirebaseNotConfiguredError extends Error {
    checked;
    constructor(checked) {
        super('Firebase Auth is not configured. Set the ICECREAM_FIREBASE_CONFIG ' +
            'environment variable (JSON), or point FIREBASE_CONFIG_PATH at a JSON ' +
            'file, or place firebase.config.json in the app userData directory. ' +
            `Checked: ${checked.join('; ')}. ` +
            'Expected shape: {"apiKey":"…","authDomain":"….firebaseapp.com","projectId":"…"}. ' +
            'Google is the only sign-in provider — no username/password is supported.');
        this.name = 'FirebaseNotConfiguredError';
        this.checked = checked;
    }
}
exports.FirebaseNotConfiguredError = FirebaseNotConfiguredError;
function isValidConfig(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return (typeof v['apiKey'] === 'string' &&
        v['apiKey'].length > 0 &&
        typeof v['authDomain'] === 'string' &&
        v['authDomain'].length > 0 &&
        typeof v['projectId'] === 'string' &&
        v['projectId'].length > 0);
}
/**
 * Load the Firebase web config from the seam. Throws
 * FirebaseNotConfiguredError (fail closed) when nothing valid is found.
 */
function loadFirebaseConfig(deps = {}) {
    const env = deps.env ?? process.env;
    const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
    const checked = [];
    // 1. Inline JSON in the environment.
    const inline = env['ICECREAM_FIREBASE_CONFIG'];
    if (inline && inline.trim().length > 0) {
        checked.push('ICECREAM_FIREBASE_CONFIG (env)');
        try {
            const parsed = JSON.parse(inline);
            if (isValidConfig(parsed))
                return parsed;
        }
        catch {
            // Fall through to the not-configured error below.
        }
        throw new FirebaseNotConfiguredError([
            ...checked,
            'ICECREAM_FIREBASE_CONFIG was set but is not valid JSON with apiKey/authDomain/projectId',
        ]);
    }
    checked.push('ICECREAM_FIREBASE_CONFIG (env, unset)');
    // 2. JSON file pointed at by the environment.
    const configPath = env['FIREBASE_CONFIG_PATH'];
    if (configPath && configPath.trim().length > 0) {
        checked.push(`FIREBASE_CONFIG_PATH=${configPath}`);
        try {
            const parsed = JSON.parse(readFile(configPath));
            if (isValidConfig(parsed))
                return parsed;
        }
        catch {
            // Fall through.
        }
        throw new FirebaseNotConfiguredError([
            ...checked,
            `FIREBASE_CONFIG_PATH was set but "${configPath}" is unreadable or invalid`,
        ]);
    }
    checked.push('FIREBASE_CONFIG_PATH (env, unset)');
    // 3. Per-user config file in the Electron userData directory.
    const userDataPath = deps.userDataPath;
    const userFile = userDataPath ? path.join(userDataPath, 'firebase.config.json') : null;
    checked.push(userFile ?? '<userData>/firebase.config.json (no userData path available)');
    if (userFile) {
        try {
            const parsed = JSON.parse(readFile(userFile));
            if (isValidConfig(parsed))
                return parsed;
        }
        catch {
            // Missing/unparseable file → not configured.
        }
    }
    throw new FirebaseNotConfiguredError(checked);
}
//# sourceMappingURL=firebase-config.js.map