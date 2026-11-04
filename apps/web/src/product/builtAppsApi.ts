/**
 * Built-apps API client (W4, hidden_files/wave-c-fixes/BRIEF.md).
 *
 * Wraps a GatewayClient for the gateway's /api/built-apps endpoints —
 * every call is authenticated. UI-built apps (AppSpec) persist there
 * keyed by the caller's principal + the gateway file id, so an app
 * built in one browser profile is listed and runnable in any profile
 * for the same user + file. The localStorage app store remains the
 * client's cache/offline copy; in gateway mode this API is the
 * authoritative copy (see product/builtAppSync.ts for the merge).
 */
import type { AppSpec } from '@icecream-sheets/service';
import {
  GatewayAuthError,
  GatewayRateLimitError,
  type GatewayClient,
} from '../services/gatewayClient';
import { ProductApiError } from './productApi';

/** One server-side built-app record (GET /api/built-apps entry). */
export interface BuiltAppRecordView {
  appId: string;
  fileId: string;
  spec: AppSpec;
  createdAt: number;
  updatedAt: number;
}

function toBuiltAppsApiError(err: unknown): ProductApiError {
  if (err instanceof ProductApiError) return err;
  if (err instanceof GatewayRateLimitError) {
    return new ProductApiError(429, err.message, 'RATE_LIMITED');
  }
  if (err instanceof GatewayAuthError) {
    return new ProductApiError(401, err.message, 'UNAUTHENTICATED');
  }
  if (err instanceof Error) {
    const m = /^gateway (\d+): ([\s\S]*)$/.exec(err.message);
    if (m) {
      const status = Number(m[1]);
      const bodyText = m[2] ?? '';
      try {
        const body = JSON.parse(bodyText) as { error?: unknown; code?: unknown };
        if (typeof body.error === 'string' && body.error) {
          return new ProductApiError(
            status,
            body.error,
            typeof body.code === 'string' ? body.code : undefined,
          );
        }
      } catch {
        // Body was not JSON — fall through with the raw text.
      }
      return new ProductApiError(status, bodyText || err.message);
    }
    return new ProductApiError(0, err.message);
  }
  return new ProductApiError(0, String(err));
}

export class BuiltAppsApi {
  private readonly client: GatewayClient;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  private async call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    try {
      return await this.client.call<T>(path, init, body);
    } catch (err) {
      throw toBuiltAppsApiError(err);
    }
  }

  /** The caller's apps bound to `fileId`, oldest first. */
  async listApps(fileId: string): Promise<AppSpec[]> {
    const res = await this.call<{ ok: true; apps: BuiltAppRecordView[] }>(
      `/api/built-apps?fileId=${encodeURIComponent(fileId)}`,
      { method: 'GET' },
    );
    return res.apps.map((a) => a.spec);
  }

  /** Create (or idempotently re-upload) an app bound to `fileId`. */
  async createApp(fileId: string, spec: AppSpec): Promise<AppSpec> {
    const res = await this.call<{ ok: true; app: BuiltAppRecordView }>(
      '/api/built-apps',
      { method: 'POST' },
      { fileId, spec },
    );
    return res.app.spec;
  }

  /** Persist a spec mutation for an app bound to `fileId`. */
  async updateApp(fileId: string, spec: AppSpec): Promise<AppSpec> {
    const res = await this.call<{ ok: true; app: BuiltAppRecordView }>(
      `/api/built-apps/${encodeURIComponent(spec.id)}`,
      { method: 'PUT' },
      { fileId, spec },
    );
    return res.app.spec;
  }

  /** Delete an app bound to `fileId` (owner-scoped server-side). */
  async deleteApp(fileId: string, appId: string): Promise<void> {
    await this.call<{ ok: true }>(
      `/api/built-apps/${encodeURIComponent(appId)}?fileId=${encodeURIComponent(fileId)}`,
      { method: 'DELETE' },
    );
  }
}
