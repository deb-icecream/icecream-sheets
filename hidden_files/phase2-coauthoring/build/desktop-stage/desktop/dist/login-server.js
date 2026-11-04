"use strict";
/**
 * Localhost login-page server (Cycle 9: Firebase Google login — desktop).
 *
 * The dedicated login BrowserWindow needs a REAL origin for Firebase's
 * Google sign-in popup flow (the auth handler postMessages the credential
 * back to the opener; opaque origins like data:/file: break that handshake).
 * This module serves the generated login page on 127.0.0.1 with an
 * ephemeral port — loopback only, never exposed to the network, torn down
 * the moment the login window closes.
 *
 * No firewall prompt: binding 127.0.0.1 never leaves the machine.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startLoginServer = startLoginServer;
const node_http_1 = __importDefault(require("node:http"));
/**
 * Serve `html` at /login on 127.0.0.1:<ephemeral>. Everything else 404s.
 */
function startLoginServer(html) {
    return new Promise((resolve, reject) => {
        const server = node_http_1.default.createServer((req, res) => {
            if (req.url === '/login' || req.url === '/') {
                const body = Buffer.from(html, 'utf8');
                res.writeHead(200, {
                    'content-type': 'text/html; charset=utf-8',
                    'content-length': body.length,
                    // The page must not be framed or cached: it carries a login flow.
                    'x-frame-options': 'DENY',
                    'cache-control': 'no-store',
                });
                res.end(body);
                return;
            }
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
        });
        server.on('error', reject);
        // 127.0.0.1 only — never 0.0.0.0.
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr.port !== 'number') {
                reject(new Error('login server: could not determine bound port'));
                return;
            }
            let closed = false;
            resolve({
                url: `http://127.0.0.1:${addr.port}/login`,
                close: () => new Promise((resClose) => {
                    if (closed) {
                        resClose();
                        return;
                    }
                    closed = true;
                    server.close(() => resClose());
                }),
            });
        });
    });
}
//# sourceMappingURL=login-server.js.map