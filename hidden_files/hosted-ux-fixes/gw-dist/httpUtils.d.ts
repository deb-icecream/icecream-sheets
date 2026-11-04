/**
 * Minimal HTTP helpers for the gateway and services (node:http only).
 *
 * - readBody: buffers the request body with a 1MB cap (fail closed on
 *   oversize bodies — 413).
 * - sendJson: JSON response with CORS headers.
 * - applyCors / handlePreflight: permissive CORS for local dev. Production
 *   (Firebase Hosting) serves the app from the same origin as the gateway
 *   or narrows these origins at the edge.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Max JSON request body: 1MB. */
export declare const MAX_BODY_BYTES: number;
export interface BodyTooLargeError extends Error {
    code: 'BODY_TOO_LARGE';
}
/**
 * Read and parse a JSON request body. Returns undefined when there is no
 * body. Throws { code: 'BODY_TOO_LARGE' } over the cap, or a SyntaxError
 * on malformed JSON. `maxBytes` overrides the default cap for endpoints
 * whose payloads are whole files (engine-service /load, Cycle 10).
 */
export declare function readBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
export declare function applyCors(res: ServerResponse): void;
/** Returns true when the request was an OPTIONS preflight (already answered). */
export declare function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean;
export declare function sendJson(res: ServerResponse, status: number, obj: unknown): void;
/** Error envelope used by every service. */
export declare function sendError(res: ServerResponse, status: number, error: string, extra?: Record<string, unknown>): void;
/** Pull the x-principal header (set by the gateway from the verified JWT). */
export declare function requestPrincipal(req: IncomingMessage, fallback?: string): string;
/** Bare token from an Authorization header, or null. */
export declare function bearerToken(req: IncomingMessage): string | null;
