/**
 * Triggers — product client for the automation trigger surface
 * (design-docs/automation-lane.md §1 recorded grants, §3 event runtime;
 * build contract: hidden_files/triggers/REPORT.md "HTTP contract").
 *
 * A trigger is a versioned TriggerSpec hosted next to the live engine
 * session (gateway/service mode) or in the desktop main process (local
 * mode). This module is the web app's ONLY access path:
 *
 *  - Gateway transport: raw fetch to `${gatewayBase}/api/automation/...`
 *    with the gateway JWT (the ProductApi/GatewayClient auth pattern —
 *    Bearer token from the GatewayClient, server `error` strings
 *    surfaced verbatim). `fileId` is the open workbook's collab file id,
 *    supplied by the caller.
 *  - Desktop transport: the `window.icecreamDesktop.triggers` bridge
 *    (list/create/remove/setEnabled/grant; no fileId — main scopes to
 *    the currently open local file).
 *
 * When neither exists (no hosted session), pickTriggerTransport returns
 * null and the UI says so honestly — there is no fake/local trigger
 * data anywhere in this module.
 *
 * Script shape: trigger scripts run in the Node sandbox as a BARE
 * script body with a live synchronous `api` global and a frozen
 * `event` global (packages/service/tests/automationSandbox.test.ts) —
 * NOT the `export function main(api)` shape of the in-page Apps Script
 * runner. The templates below use that shape.
 */
import { parseA1RangeRef, type RangeRef } from '@icecream-sheets/engine';
import type {
  DeclaredPermission,
  TriggerEvent,
  TriggerLanguage,
  TriggerSpec,
  TriggerSpecInit,
} from '@icecream-sheets/service';
import type { GatewayClient } from '../services/gatewayClient';

export type { DeclaredPermission, TriggerEvent, TriggerLanguage, TriggerSpec, TriggerSpecInit };
export type { RangeRef };

/** One trigger as the management surface reports it (contract). */
export interface TriggerStatus extends TriggerSpec {
  /** True once every declared permission has been granted (§1). */
  granted: boolean;
  /** Most recent run outcome; null when the trigger has never run. */
  lastRun: { ok: boolean; error?: string; durationMs: number } | null;
}

/** GET /api/automation/triggers result (the `ok:true` envelope stripped). */
export interface TriggerListResult {
  /** Events the current topology can actually fire — the UI offers only these. */
  events: string[];
  triggers: TriggerStatus[];
}

/** The management operations both transports implement (contract). */
export interface TriggerTransport {
  list(): Promise<TriggerListResult>;
  create(spec: TriggerSpecInit): Promise<TriggerStatus>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  grant(id: string): Promise<void>;
}

/** A transport failure with a plain-language, user-showable message. */
export class TriggerTransportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'TriggerTransportError';
    this.status = status;
  }
}

function transportError(status: number, bodyText: string): TriggerTransportError {
  let message = bodyText || `request failed (${status})`;
  try {
    const body = JSON.parse(bodyText) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) message = body.error;
  } catch {
    // Non-JSON error body — keep the raw text.
  }
  return new TriggerTransportError(status, message);
}

/* ------------------------------------------------------------------ */
/* Gateway transport                                                   */
/* ------------------------------------------------------------------ */

export interface GatewayTriggerTransportOptions {
  /** Gateway base URL (no trailing slash needed). */
  baseUrl: string;
  /** Supplies the current gateway JWT (GatewayClient.getToken). */
  getToken: () => string | null;
  /** The open workbook's collab file id. */
  fileId: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

export class GatewayTriggerTransport implements TriggerTransport {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly fileId: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GatewayTriggerTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getToken = opts.getToken;
    this.fileId = opts.fileId;
    this.fetchFn = opts.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  private async request<T>(path: string, init: RequestInit, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = this.getToken();
    if (token) headers['authorization'] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new TriggerTransportError(
        0,
        `Could not reach the server: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok) {
      throw transportError(res.status, await res.text().catch(() => ''));
    }
    return (await res.json()) as T;
  }

  async list(): Promise<TriggerListResult> {
    const res = await this.request<{ ok: true } & TriggerListResult>(
      `/api/automation/triggers?fileId=${encodeURIComponent(this.fileId)}`,
      { method: 'GET' },
    );
    return { events: res.events ?? [], triggers: res.triggers ?? [] };
  }

  async create(spec: TriggerSpecInit): Promise<TriggerStatus> {
    const res = await this.request<{ ok: true; trigger: TriggerStatus }>(
      `/api/automation/triggers?fileId=${encodeURIComponent(this.fileId)}`,
      { method: 'POST' },
      { fileId: this.fileId, spec },
    );
    return res.trigger;
  }

  async remove(id: string): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/automation/triggers/${encodeURIComponent(id)}?fileId=${encodeURIComponent(this.fileId)}`,
      { method: 'DELETE' },
    );
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/automation/triggers/${encodeURIComponent(id)}/enabled?fileId=${encodeURIComponent(this.fileId)}`,
      { method: 'POST' },
      { fileId: this.fileId, enabled },
    );
  }

  async grant(id: string): Promise<void> {
    await this.request<{ ok: true }>(
      `/api/automation/triggers/${encodeURIComponent(id)}/grant?fileId=${encodeURIComponent(this.fileId)}`,
      { method: 'POST' },
      { fileId: this.fileId },
    );
  }
}

/** Build the gateway transport from the app's shared GatewayClient. */
export function gatewayTriggerTransport(
  client: Pick<GatewayClient, 'baseUrl' | 'getToken'>,
  fileId: string,
  fetchFn?: typeof fetch,
): GatewayTriggerTransport {
  return new GatewayTriggerTransport({
    baseUrl: client.baseUrl,
    getToken: () => client.getToken(),
    fileId,
    fetchFn,
  });
}

/* ------------------------------------------------------------------ */
/* Desktop transport (window.icecreamDesktop.triggers bridge)          */
/* ------------------------------------------------------------------ */

/** The desktop bridge surface for triggers (mirrors the contract, minus fileId). */
export interface DesktopTriggersBridge {
  list(): Promise<TriggerListResult>;
  create(spec: TriggerSpecInit): Promise<TriggerStatus>;
  remove(id: string): Promise<unknown>;
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
  grant(id: string): Promise<unknown>;
}

export class DesktopTriggerTransport implements TriggerTransport {
  private readonly bridge: DesktopTriggersBridge;
  constructor(bridge: DesktopTriggersBridge) {
    this.bridge = bridge;
  }

  list(): Promise<TriggerListResult> {
    return this.bridge.list();
  }
  create(spec: TriggerSpecInit): Promise<TriggerStatus> {
    return this.bridge.create(spec);
  }
  async remove(id: string): Promise<void> {
    await this.bridge.remove(id);
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.bridge.setEnabled(id, enabled);
  }
  async grant(id: string): Promise<void> {
    await this.bridge.grant(id);
  }
}

/** The desktop triggers bridge, when running in the desktop shell with one. */
export function desktopTriggersBridge(
  win: { icecreamDesktop?: { triggers?: DesktopTriggersBridge } } | undefined =
    typeof window !== 'undefined'
      ? (window as unknown as { icecreamDesktop?: { triggers?: DesktopTriggersBridge } })
      : undefined,
): DesktopTriggersBridge | null {
  return win?.icecreamDesktop?.triggers ?? null;
}

/* ------------------------------------------------------------------ */
/* Transport selection                                                 */
/* ------------------------------------------------------------------ */

export interface PickTriggerTransportOptions {
  /** Desktop bridge, when present (defaults to the live window bridge). */
  desktopBridge?: DesktopTriggersBridge | null;
  /** The app's gateway client, when in gateway mode. */
  gatewayClient?: Pick<GatewayClient, 'baseUrl' | 'getToken'> | null;
  /** The open workbook's collab file id (required for the gateway surface). */
  fileId?: string | null;
  /** Injectable fetch for the gateway transport (tests). */
  fetchFn?: typeof fetch;
}

/**
 * Pick the trigger transport for the current session:
 * desktop bridge when present; otherwise the gateway surface when a
 * file id + gateway client exist; otherwise null (no hosted session —
 * the UI shows an honest note instead of fake data).
 */
export function pickTriggerTransport(opts: PickTriggerTransportOptions): TriggerTransport | null {
  const bridge = opts.desktopBridge !== undefined ? opts.desktopBridge : desktopTriggersBridge();
  if (bridge) return new DesktopTriggerTransport(bridge);
  if (opts.gatewayClient && opts.fileId) {
    return gatewayTriggerTransport(opts.gatewayClient, opts.fileId, opts.fetchFn);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* A1 range parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse A1-style range text ("A1", "A1:B2", "Sheet1!A1:B2") into the
 * spec's RangeRef. The sheet comes from the text's `Sheet!` prefix when
 * present, else `sheetName`, else 'Sheet1'. Returns null on bad input.
 * Uses the engine's own A1 parser (the same one other dialogs use).
 */
export function parseTriggerRange(rangeText: string, sheetName?: string): RangeRef | null {
  const text = rangeText.trim();
  if (!text) return null;
  const parsed = parseA1RangeRef(text, sheetName?.trim() || 'Sheet1');
  if (!parsed) return null;
  return {
    sheet: parsed.sheet,
    startRow: parsed.startRow,
    startCol: parsed.startCol,
    endRow: parsed.endRow,
    endCol: parsed.endCol,
  };
}

/** Render a RangeRef back to A1 text for display ("Sheet1!A1:B2"). */
export function rangeToA1(range: RangeRef): string {
  const cell = (row: number, col: number): string => {
    let letters = '';
    let c = col;
    do {
      letters = String.fromCharCode(65 + (c % 26)) + letters;
      c = Math.floor(c / 26) - 1;
    } while (c >= 0);
    return `${letters}${row + 1}`;
  };
  const start = cell(range.startRow, range.startCol);
  const end = cell(range.endRow, range.endCol);
  return `${range.sheet}!${start}${start === end ? '' : `:${end}`}`;
}

/* ------------------------------------------------------------------ */
/* Script templates + default permissions (node-sandbox shape)         */
/* ------------------------------------------------------------------ */

export const TRIGGER_EVENT_LABELS: Record<string, string> = {
  onOpen: 'When the workbook opens',
  onEdit: 'When a cell is edited',
  onSelectionChange: 'When the selection changes',
  onInterval: 'On an interval',
  onAtTime: 'At a specific time',
};

/**
 * Default declared permissions for a new trigger, in the REAL
 * automation vocabulary (packages/service AUTOMATION_ACTIONS targets:
 * cell targets are `Sheet!col,row`). The templates write one marker
 * cell (K1 = col 10, row 0 on Sheet1) and post one notification.
 */
export function defaultTriggerPermissions(): DeclaredPermission[] {
  return [
    { action: 'cell.write', target: 'Sheet1!10,0', reason: 'Write the marker cell when the trigger fires' },
    { action: 'ui.notify', target: 'workbook', reason: 'Tell you when the trigger fires' },
  ];
}

const JS_TEMPLATES: Record<string, string> = {
  onEdit: `// Trigger script — bare sandbox body with a live \`api\` and a frozen
// \`event\` (event.type is 'edit'; event.refs lists the edited cells).
api.setCell({ sheet: 'Sheet1', row: 0, col: 10 }, 'edited');
api.notify('Edit trigger fired');
`,
  onOpen: `// Trigger script — bare sandbox body with a live \`api\` and a frozen
// \`event\` (event.type is 'open').
api.setCell({ sheet: 'Sheet1', row: 0, col: 10 }, 'opened');
api.notify('Open trigger fired');
`,
  onInterval: `// Trigger script — bare sandbox body with a live \`api\` and a frozen
// \`event\` (event.type is 'timer').
api.setCell({ sheet: 'Sheet1', row: 0, col: 10 }, 'interval');
api.notify('Interval trigger fired');
`,
  onAtTime: `// Trigger script — bare sandbox body with a live \`api\` and a frozen
// \`event\` (event.type is 'timer').
api.setCell({ sheet: 'Sheet1', row: 0, col: 10 }, 'scheduled');
api.notify('Scheduled trigger fired');
`,
};

const PY_TEMPLATES: Record<string, string> = {
  onEdit: `# Trigger script — Python collects actions; each action replays
# through the permissioned automation API.
actions = [
  {"method": "setCell", "args": [{"sheet": "Sheet1", "row": 0, "col": 10}, "edited"]},
  {"method": "notify", "args": ["Edit trigger fired"]},
]
`,
  onOpen: `# Trigger script — Python collects actions; each action replays
# through the permissioned automation API.
actions = [
  {"method": "setCell", "args": [{"sheet": "Sheet1", "row": 0, "col": 10}, "opened"]},
  {"method": "notify", "args": ["Open trigger fired"]},
]
`,
  onInterval: `# Trigger script — Python collects actions; each action replays
# through the permissioned automation API.
actions = [
  {"method": "setCell", "args": [{"sheet": "Sheet1", "row": 0, "col": 10}, "interval"]},
  {"method": "notify", "args": ["Interval trigger fired"]},
]
`,
  onAtTime: `# Trigger script — Python collects actions; each action replays
# through the permissioned automation API.
actions = [
  {"method": "setCell", "args": [{"sheet": "Sheet1", "row": 0, "col": 10}, "scheduled"]},
  {"method": "notify", "args": ["Scheduled trigger fired"]},
]
`,
};

const GENERIC_JS_TEMPLATE = `// Trigger script — bare sandbox body with a live \`api\` and a frozen
// \`event\` object describing what fired it.
api.notify('Trigger fired');
`;

/** Starter script for an event, in the node-sandbox (bare body) shape. */
export function triggerTemplate(event: string, language: TriggerLanguage = 'javascript'): string {
  if (language === 'python') return PY_TEMPLATES[event] ?? PY_TEMPLATES['onEdit']!;
  return JS_TEMPLATES[event] ?? GENERIC_JS_TEMPLATE;
}
