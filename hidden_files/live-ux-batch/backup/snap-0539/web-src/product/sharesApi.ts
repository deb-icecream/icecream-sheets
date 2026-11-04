/**
 * App-share API client (idea-app-gallery, user-confirmed share design
 * 2026-10-21). Wraps a GatewayClient for the gateway's /api/shares*
 * endpoints — every call is authenticated (sharing requires sign-in).
 *
 * A share is an app WITH a materialized snapshot of its bound data
 * (AppSharePackage from @icecream-sheets/service). The gateway stores
 * it per link; a signed-in recipient fetches the package and
 * materializes their OWN bound copies — the owner's data is never
 * exposed to recipient edits, and credentials never travel (the
 * gateway validates the package, rejecting credential-shaped keys).
 */
import type { AppSharePackage } from '@icecream-sheets/service';
import {
  GatewayAuthError,
  GatewayRateLimitError,
  type GatewayClient,
} from '../services/gatewayClient';
import { ProductApiError } from './productApi';

/** "Shared by you" entry — metadata only, never the package itself. */
export interface AppShareSummary {
  shareId: string;
  ownerPrincipal: string;
  appName: string;
  sourceSheet: string;
  rowCount: number;
  colCount: number;
  createdAt: number;
  revokedAt: number | null;
}

/** GET /api/shares/:id result: metadata + the app+data package. */
export interface FetchedShare {
  share: AppShareSummary;
  pkg: AppSharePackage;
}

function toSharesApiError(err: unknown): ProductApiError {
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

export class SharesApi {
  private readonly client: GatewayClient;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  private async call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    try {
      return await this.client.call<T>(path, init, body);
    } catch (err) {
      throw toSharesApiError(err);
    }
  }

  /** Create a share link for an app+data package. */
  async createShare(pkg: AppSharePackage): Promise<AppShareSummary> {
    const res = await this.call<{ ok: true; share: AppShareSummary }>(
      '/api/shares',
      { method: 'POST' },
      { package: pkg },
    );
    return res.share;
  }

  /** The caller's "shared by you" list (active + revoked). */
  async listMyShares(): Promise<AppShareSummary[]> {
    const res = await this.call<{ ok: true; shares: AppShareSummary[] }>('/api/shares', {
      method: 'GET',
    });
    return res.shares;
  }

  /** Recipient side: fetch a share's package by id (404 when revoked/missing). */
  async getShare(shareId: string): Promise<FetchedShare> {
    const res = await this.call<{ ok: true; share: AppShareSummary; package: AppSharePackage }>(
      `/api/shares/${encodeURIComponent(shareId)}`,
      { method: 'GET' },
    );
    return { share: res.share, pkg: res.package };
  }

  /** Per-link revoke (owner only server-side). */
  async revokeShare(shareId: string): Promise<void> {
    await this.call<{ ok: true }>(`/api/shares/${encodeURIComponent(shareId)}`, {
      method: 'DELETE',
    });
  }
}

/** The recipient-facing link for a share: app URL + ?share=<id>. */
export function buildShareLink(baseUrl: string, shareId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('share', shareId);
  url.hash = '';
  return url.toString();
}

/** Extract a share id from a URL search string (`?share=...`), if any. */
export function shareIdFromSearch(search: string): string | null {
  try {
    const id = new URLSearchParams(search).get('share');
    return id && id.trim() ? id : null;
  } catch {
    return null;
  }
}
