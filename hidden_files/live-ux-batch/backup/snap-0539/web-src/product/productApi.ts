/**
 * Product-layer API client (tiers, workspace file catalog, upload flow).
 *
 * Wraps a GatewayClient: every /api/files* call goes through
 * `GatewayClient.call` (the single authenticated funnel — Bearer gateway
 * JWT, rate-limit handling). The ONE exception is the staging PUT inside
 * `uploadFile`: the upload grant returns a signed URL and that URL IS
 * the authorization, so the bytes go with a raw `fetch` and NO gateway
 * auth headers (CONTRACT.md §Gateway endpoints / §Web).
 *
 * Errors: the gateway's error JSON is `{ ok:false, error, code?, ... }`.
 * `GatewayClient.call` flattens a non-OK response into
 * `Error("gateway <status>: <body text>")`, so ProductApi unwraps that
 * shape and rethrows a ProductApiError carrying the HTTP status, the
 * server's `code`, and the server's `error` message VERBATIM — the
 * workspace displays cap errors (UPLOAD_TOO_LARGE / FILE_LIMIT_REACHED)
 * to the user exactly as the server worded them.
 */
import {
  GatewayAuthError,
  GatewayRateLimitError,
  type GatewayClient,
} from '../services/gatewayClient';
import {
  defaultSettingsView,
  type ThemeChoice,
  type UserSettingsView,
} from './userSettings';

export type Tier = 'default' | 'pro';

/** One file in the user's workspace catalog (CONTRACT.md §File catalog). */
export interface UserFileRecord {
  fileId: string;
  ownerPrincipal: string;
  name: string;
  /** 'shared' = a copy received by accepting a share (app + data). */
  origin: 'upload' | 'created' | 'shared';
  /**
   * Format the file was originally uploaded as. CSV uploads convert to
   * a native workbook at open; the record keeps the original format so
   * the UI can mark the file as imported from CSV. Absent on records
   * from older servers — treat undefined as 'xlsx'.
   */
  sourceFormat?: 'xlsx' | 'csv' | 'xls';
  sizeBytes: number;
  storageRef: { bucket: string; object: string } | null;
  libraryEntryId: string | null;
  hasStoredState: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

/** Tier limits from GET /api/files; both fields are null for Pro. */
export interface FileLimits {
  uploadMaxBytes: number | null;
  fileLimit: number | null;
}

/** GET /api/files result (the `ok:true` envelope field is stripped). */
export interface FileListResult {
  tier: Tier;
  limits: FileLimits;
  count: number;
  files: UserFileRecord[];
}

/** The caller's own tier/limits/count, as reported by GET /api/files. */
export interface MeResult {
  tier: Tier;
  limits: FileLimits;
  count: number;
}

/** POST /api/files/upload-grant result. */
export interface UploadGrantResult {
  fileId: string;
  object: string;
  upload: { url: string; expiresAt: number; method: 'PUT' };
}

/** Patch accepted by PATCH /api/files/:fileId. */
export interface FilePatch {
  name?: string;
  hasStoredState?: boolean;
  libraryEntryId?: string | null;
}

/**
 * A product-layer failure. `message` is the server's `error` string
 * verbatim whenever the server provided one; `code` is the server's
 * machine-readable code (e.g. 'UPLOAD_TOO_LARGE') when present.
 */
export class ProductApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** The gateway's parsed error body, when it was JSON (structured
   * extras survive here even if the message form truncated them). */
  readonly body: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = 'ProductApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Convert anything the gateway funnel throws into a ProductApiError.
 * GatewayClient.call throws:
 *  - GatewayAuthError on 401, GatewayRateLimitError on 429;
 *  - Error("gateway <status>: <response body, ≤200 chars>") otherwise,
 *    where the body is the gateway's error JSON — parse it back out so
 *    the server's `error` message and `code` survive verbatim.
 */
function toProductApiError(err: unknown): ProductApiError {
  if (err instanceof ProductApiError) return err;
  if (err instanceof GatewayRateLimitError) {
    return new ProductApiError(429, err.message, 'RATE_LIMITED');
  }
  if (err instanceof GatewayAuthError) {
    return new ProductApiError(401, err.message, 'UNAUTHENTICATED');
  }
  if (err instanceof Error) {
    // GatewayClient attaches the full parsed error body (gatewayBody)
    // because the message form truncates it at 200 chars; the message
    // parse below remains as the fallback for short bodies.
    const attached = (err as { gatewayBody?: unknown }).gatewayBody;
    const m = /^gateway (\d+): ([\s\S]*)$/.exec(err.message);
    if (m) {
      const status = Number(m[1]);
      const bodyText = m[2] ?? '';
      let body: unknown = attached;
      if (body === undefined) {
        try {
          body = JSON.parse(bodyText) as unknown;
        } catch {
          body = undefined;
        }
      }
      const b = body as { error?: unknown; code?: unknown } | undefined;
      if (b && typeof b.error === 'string' && b.error) {
        return new ProductApiError(
          status,
          b.error,
          typeof b.code === 'string' ? b.code : undefined,
          body,
        );
      }
      return new ProductApiError(status, bodyText || err.message, undefined, body);
    }
    return new ProductApiError(0, err.message, undefined, attached);
  }
  return new ProductApiError(0, String(err));
}

export class ProductApi {
  private readonly client: GatewayClient;

  constructor(client: GatewayClient) {
    this.client = client;
  }

  /** Run one gateway call, normalizing every failure to ProductApiError. */
  private async call<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    try {
      return await this.client.call<T>(path, init, body);
    } catch (err) {
      throw toProductApiError(err);
    }
  }

  /**
   * The caller's workspace settings (GET /api/settings). A 404 means
   * "nothing saved yet" — the caller gets the default view
   * (provider name, System theme), NOT an error.
   */
  async getSettings(): Promise<UserSettingsView> {
    try {
      const res = await this.call<{
        ok: true;
        settings: {
          user: { displayName: string | null; email: string | null; googleName: string | null };
          office: { theme: ThemeChoice };
        };
      }>('/api/settings', { method: 'GET' });
      return {
        hasRecord: true,
        displayName: res.settings.user.displayName,
        email: res.settings.user.email,
        googleName: res.settings.user.googleName,
        theme: res.settings.office.theme,
      };
    } catch (err) {
      if (err instanceof ProductApiError && err.status === 404) {
        const view = defaultSettingsView();
        // The 404 body echoes the caller's provider identity from the
        // verified claims (D4): a first-run user still gets their real
        // email + Google name in the default view.
        const echo = (
          err.body as
            | { user?: { email?: unknown; googleName?: unknown } }
            | undefined
        )?.user;
        if (echo) {
          if (typeof echo.email === 'string') view.email = echo.email;
          if (typeof echo.googleName === 'string') view.googleName = echo.googleName;
        }
        return view;
      }
      throw err;
    }
  }

  /**
   * Save settings (PUT /api/settings, partial merge server-side).
   * Only the fields present in `patch` are sent. Email is never
   * sendable — the gateway rejects any email key (EMAIL_READ_ONLY).
   */
  async updateSettings(patch: {
    displayName?: string | null;
    theme?: ThemeChoice;
  }): Promise<UserSettingsView> {
    const body: { user?: { displayName: string | null }; office?: { theme: ThemeChoice } } = {};
    if (patch.displayName !== undefined) body.user = { displayName: patch.displayName };
    if (patch.theme !== undefined) body.office = { theme: patch.theme };
    const res = await this.call<{
      ok: true;
      settings: {
        user: { displayName: string | null; email: string | null; googleName: string | null };
        office: { theme: ThemeChoice };
      };
    }>('/api/settings', { method: 'PUT' }, body);
    return {
      hasRecord: true,
      displayName: res.settings.user.displayName,
      email: res.settings.user.email,
      googleName: res.settings.user.googleName,
      theme: res.settings.office.theme,
    };
  }

  /**
   * Delete the caller's profile and data (DELETE /api/account): the
   * settings record, tier record, file catalog + stored bytes, and
   * owned shares, server-side. Returns the per-store deletion counts.
   */
  async deleteAccount(): Promise<{ deleted: Record<string, number | boolean> }> {
    const res = await this.call<{ ok: true; deleted: Record<string, number | boolean> }>(
      '/api/account',
      { method: 'DELETE' },
    );
    return { deleted: res.deleted };
  }

  /** The caller's tier, limits, and current file count. */
  async me(): Promise<MeResult> {
    const res = await this.call<{ ok: true } & FileListResult>('/api/files', {
      method: 'GET',
    });
    return { tier: res.tier, limits: res.limits, count: res.count };
  }

  /** The full workspace listing (recents order: lastOpenedAt DESC). */
  async listFiles(): Promise<FileListResult> {
    const res = await this.call<{ ok: true } & FileListResult>('/api/files', {
      method: 'GET',
    });
    return { tier: res.tier, limits: res.limits, count: res.count, files: res.files };
  }

  /**
   * Create a blank in-app file (counts toward the Default file limit).
   * `origin: 'shared'` marks a received share copy (the share-accept
   * flow materializes the recipient's own data copy as a catalog file);
   * the gateway validates the value.
   */
  async createFile(name: string, origin?: 'created' | 'shared'): Promise<UserFileRecord> {
    const res = await this.call<{ ok: true; file: UserFileRecord }>(
      '/api/files',
      { method: 'POST' },
      origin ? { name, origin } : { name },
    );
    return res.file;
  }

  /** One file record by id (404 — as ProductApiError — when missing/not owned). */
  async getFile(fileId: string): Promise<UserFileRecord> {
    const res = await this.call<{ ok: true; file: UserFileRecord }>(
      `/api/files/${encodeURIComponent(fileId)}`,
      { method: 'GET' },
    );
    return res.file;
  }

  /** Rename a file (PATCH). */
  async renameFile(fileId: string, name: string): Promise<UserFileRecord> {
    return this.markOpened(fileId, { name });
  }

  /** PATCH a file record (rename, stored-state flags, opened marker). */
  async markOpened(fileId: string, patch: FilePatch): Promise<UserFileRecord> {
    const res = await this.call<{ ok: true; file: UserFileRecord }>(
      `/api/files/${encodeURIComponent(fileId)}`,
      { method: 'PATCH' },
      patch,
    );
    return res.file;
  }

  /** Delete a file record (and its staged object, server-side). */
  async deleteFile(fileId: string): Promise<void> {
    await this.call<{ ok: true }>(`/api/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    });
  }

  /** Ask the gateway to issue a signed staging URL for an upload. */
  async uploadGrant(name: string, size: number): Promise<UploadGrantResult> {
    const res = await this.call<{ ok: true } & UploadGrantResult>(
      '/api/files/upload-grant',
      { method: 'POST' },
      { name, size },
    );
    return { fileId: res.fileId, object: res.object, upload: res.upload };
  }

  /** Finalize an upload after its bytes reached the staging URL. */
  async completeUpload(fileId: string, name: string): Promise<UserFileRecord> {
    const res = await this.call<{ ok: true; file: UserFileRecord }>(
      `/api/files/${encodeURIComponent(fileId)}/complete-upload`,
      { method: 'POST' },
      { name },
    );
    return res.file;
  }

  /** A signed URL to download the file's stored bytes. */
  async downloadGrant(fileId: string): Promise<string> {
    const res = await this.call<{ ok: true; url: string }>(
      `/api/files/${encodeURIComponent(fileId)}/download-grant`,
      { method: 'POST' },
      {},
    );
    return res.url;
  }

  /**
   * Full upload flow: grant → PUT the bytes DIRECTLY to the signed
   * staging URL (raw fetch, no gateway auth headers — the signed URL is
   * the grant) → complete-upload, which re-checks the actual size and
   * creates the catalog record.
   */
  async uploadFile(file: File): Promise<UserFileRecord> {
    const grant = await this.uploadGrant(file.name, file.size);
    let res: Response;
    try {
      res = await fetch(grant.upload.url, {
        method: grant.upload.method ?? 'PUT',
        body: file,
      });
    } catch (err) {
      throw new ProductApiError(
        0,
        `upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text || `upload failed: ${res.status}`;
      let code: string | undefined;
      try {
        const body = JSON.parse(text) as { error?: unknown; code?: unknown };
        if (typeof body.error === 'string' && body.error) message = body.error;
        if (typeof body.code === 'string') code = body.code;
      } catch {
        // Non-JSON staging error body — keep the raw text as the message.
      }
      throw new ProductApiError(res.status, message, code);
    }
    return this.completeUpload(grant.fileId, file.name);
  }
}
