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
exports.gatewayUrl = gatewayUrl;
exports.loadToken = loadToken;
exports.saveToken = saveToken;
exports.clearToken = clearToken;
exports.login = login;
exports.logout = logout;
exports.status = status;
exports.serviceCall = serviceCall;
/**
 * Desktop remote-service client (spec d).
 *
 * The desktop ships the engine LOCALLY and works fully offline with it.
 * Services that are NOT part of the local engine — AI Agent host, ETL
 * runner, vault-backed connectors, metadata — live behind the API gateway
 * and require the user to LOG IN:
 *   logged in  → desktop talks to the deployed services via the gateway
 *   logged out → local engine features only; remote calls fail closed
 *
 * The JWT is encrypted with Electron safeStorage and kept in the main
 * process; the renderer never sees it (it calls svc:call via IPC).
 */
const electron_1 = require("electron");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const mcp_1 = require("./mcp");
/** Gateway base URL: env override, else localhost (local dev). */
function gatewayUrl() {
    return (process.env.ICECREAM_GATEWAY_URL ?? 'http://localhost:8100').replace(/\/+$/, '');
}
function tokenPath() {
    return path.join(electron_1.app.getPath('userData'), 'gateway-token.bin');
}
function decodeSub(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf8'));
        return typeof payload.sub === 'string' ? payload.sub : null;
    }
    catch {
        return null;
    }
}
/**
 * Load the stored gateway JWT (Cycle 9: shared by the local-dev userId
 * login AND the Firebase Google login — one token, one storage path).
 * Exported for the Firebase exchange in ./firebase-auth.
 */
function loadToken() {
    try {
        const p = tokenPath();
        if (!fs.existsSync(p))
            return null;
        const encrypted = fs.readFileSync(p);
        if (!electron_1.safeStorage.isEncryptionAvailable())
            return null;
        return electron_1.safeStorage.decryptString(encrypted);
    }
    catch {
        return null;
    }
}
/** Persist the gateway JWT, encrypted. Exported for ./firebase-auth. */
function saveToken(token) {
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        throw new Error('secure storage is not available on this machine');
    }
    fs.writeFileSync(tokenPath(), electron_1.safeStorage.encryptString(token), { mode: 0o600 });
}
/** Drop the stored gateway JWT. Exported for ./firebase-auth. */
function clearToken() {
    try {
        fs.unlinkSync(tokenPath());
    }
    catch {
        // Already gone — fine.
    }
}
/** Log in against the gateway (local-dev /auth/login; prod uses the real IdP). */
async function login(userId) {
    const id = userId.trim();
    if (!id)
        throw new Error('user id is required');
    const res = await fetch(`${gatewayUrl()}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: id }),
    });
    if (!res.ok)
        throw new Error(`login failed: gateway returned ${res.status}`);
    const body = (await res.json());
    if (!body.token)
        throw new Error('login returned no token');
    saveToken(body.token);
    return status();
}
/** Log out: drop the stored token. */
function logout() {
    clearToken();
}
/** Current auth status (principal decoded from the JWT; gateway verifies). */
function status() {
    const token = loadToken();
    if (!token)
        return { loggedIn: false, principal: null };
    return { loggedIn: true, principal: decodeSub(token) };
}
/**
 * Call a remote service.
 *
 * 'mcp' is NOT gateway-routed: the gateway deliberately has no /api/mcp
 * route (user's deployment ruling — MCP is its own direct ingress). MCP
 * calls go straight to the desktop's own MCP ingress at desktopMcpUrl()
 * (design-docs/platform-shell.md §8), sharing the local EngineHost. Like
 * the local engine itself, MCP works offline and never requires login.
 *
 * Every other service lives behind the API gateway and fails closed when
 * logged out (spec d: logged-out desktop = local engine features only).
 */
async function serviceCall(service, path, method, body) {
    if (service === 'mcp') {
        const m = method.toUpperCase();
        if (m !== 'POST' && m !== 'CALL') {
            throw new Error(`mcp: unsupported method "${method}" — pass the tool name as path with method POST`);
        }
        return (0, mcp_1.callLocalMcpTool)(path, body);
    }
    const token = loadToken();
    if (!token) {
        throw new Error('Not signed in. Remote services (AI agent, ETL, vault) require login — use Account → Sign in.');
    }
    const clean = path.startsWith('/') ? path : `/${path}`;
    const res = await fetch(`${gatewayUrl()}/api/${service}${clean}`, {
        method,
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
        clearToken();
        throw new Error('Session expired — please sign in again (Account → Sign in).');
    }
    if (res.status === 429)
        throw new Error('Rate limited by the gateway — try again shortly.');
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`service ${service} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json());
}
//# sourceMappingURL=services.js.map