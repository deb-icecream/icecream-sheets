/**
 * Engine access layer for the web UI.
 *
 * The UI is a PURE CONSUMER of the engine protocol: everything goes through
 * EngineHost.execute() / readCell() / readRange() / snapshot() / subscribe().
 * This module (and the whole app) never imports 'hyperformula' directly.
 */
import {
  Authorizer,
  EngineHost,
  EngineWorkbook,
  registerLocales,
  type CalculationMode,
  type CellInput,
  type CellRef,
  type TypedValue,
} from '@icecream-sheets/engine';
import { formatWithCode } from '@icecream-sheets/xlsx-adapter';

// Web startup: register all 7 formula locale packs before any host exists
// (idempotent; the engine also registers at module-evaluation time).
registerLocales();

// ---------------------------------------------------------------------------
// Host singleton
// ---------------------------------------------------------------------------

import { getGatewayClient, type GatewayClient } from './services/gatewayClient';
import { isDesktop } from './services/desktopAgent';
import { RemoteEngineHost } from './services/remoteEngine';
import { IpcEngineHost } from './services/ipcEngine';
import { SignedEngineTransport, signedEngineAccessEnabled } from './services/signedEngineTransport';

/**
 * Build the remote host for a gateway client: the SIGNED transport when
 * the build sets VITE_ENGINE_ACCESS_MODE=signed (production pattern —
 * gateway-issued token, direct engine connection), the default proxy
 * transport otherwise (today's topology, unchanged).
 */
function remoteHostFor(gw: GatewayClient): RemoteEngineHost {
  return signedEngineAccessEnabled()
    ? new RemoteEngineHost(gw, 1500, new SignedEngineTransport(gw))
    : new RemoteEngineHost(gw);
}

/**
 * Gateway mode (spec a/c): when built with VITE_GATEWAY_URL, the web app
 * talks to the engine service through the API gateway instead of running
 * the engine in-process. Desktop (Electron) runs the engine in the MAIN
 * process (Cycle 10 engine/view separation) and reaches it through the
 * IPC-backed IpcEngineHost — the renderer never runs the engine itself,
 * so engine work never blocks the renderer's UI thread. Desktop reaches
 * remote services through its own login-gated client (spec d).
 */
function createInitialHost(): EngineHost {
  const gw = getGatewayClient();
  if (gw && gw.getToken()) {
    // Gateway mode with a stored session: connect to the engine service.
    // A stale/expired token falls back to the login gate (never a crash —
    // the gate renders and connectGatewayHost() runs after a fresh login).
    // Desktop (revision-model doc §11, two modes): a renderer holding a
    // gateway JWT is LOGGED IN and is a client of the service exactly
    // like a web browser — it joins the server session through this same
    // remote host. A desktop renderer WITHOUT a gateway JWT falls
    // through to the local main-process engine (logged-out mode,
    // unchanged).
    try {
      return remoteHostFor(gw);
    } catch {
      if (!isDesktop()) gw.clearToken();
    }
  }
  if (isDesktop()) {
    // Cycle 10: the workbook lives in the main-process engine; the
    // renderer is a pure consumer over the async IPC bridge
    // (window.icecream). No in-process EngineHost on the UI thread.
    return new IpcEngineHost();
  }
  // Local mode, or gateway mode before login: in-process engine.
  return new EngineHost();
}

/**
 * Switch the app to the remote engine after gateway login (spec a/c).
 * Replaces the module host and notifies subscribers (App re-renders).
 */
export function connectGatewayHost(): EngineHost {
  // §11: a logged-in desktop renderer connects exactly like a web client;
  // the gateway client is the same one the desktop login gate is skipped
  // for (desktop login happens through the shell, the JWT lands in the
  // same localStorage slot the web login writes).
  const gw = getGatewayClient();
  if (!gw) throw new Error('gateway mode is not configured');
  if (!gw.getToken()) throw new Error('not logged in to the gateway');
  host = remoteHostFor(gw);
  notifyHostReplaced();
  return host;
}

let host: EngineHost = createInitialHost();
const hostListeners = new Set<() => void>();

/** True when the app is driving the engine through the API gateway. */
export function isGatewayMode(): boolean {
  return host instanceof RemoteEngineHost;
}

/** The gateway client in gateway mode, else null. */
export function getGateway(): import('./services/gatewayClient').GatewayClient | null {
  return getGatewayClient();
}

/** The active engine host. */
export function getHost(): EngineHost {
  return host;
}

/**
 * Replace the active host (used when opening a file: the workbook is rebuilt
 * from the imported data). Disposes the old host and notifies listeners.
 * An optional authorizer (e.g. protectionPolicy composed over the access
 * policy) is installed on the new host; callers should also re-install the
 * hidden-cell check via host.setHiddenCheck().
 */
export function replaceHost(workbook: EngineWorkbook, authorizer?: Authorizer): EngineHost {
  if (isDesktop()) {
    // Cycle 10: desktop workbooks live in the main-process engine. A
    // local replaceHost here would silently fork the workbook back onto
    // the renderer's UI thread — fail loudly instead. Desktop opens go
    // through IpcEngineHost.loadIpc() and notifyHostReplaced().
    throw new Error(
      'replaceHost: on desktop the workbook lives in the main-process engine — use IpcEngineHost.loadIpc() + notifyHostReplaced()',
    );
  }
  host.dispose();
  host = authorizer ? new EngineHost(workbook, authorizer) : new EngineHost(workbook);
  for (const l of [...hostListeners]) {
    try {
      l();
    } catch {
      // A failing listener must not break host replacement.
    }
  }
  return host;
}

/** Subscribe to host replacement. Returns an unsubscribe function. */
export function onHostReplaced(listener: () => void): () => void {
  hostListeners.add(listener);
  return () => {
    hostListeners.delete(listener);
  };
}

/**
 * Fire host-replaced listeners without swapping the host object (used by
 * the remote engine: New/Open mutate server-side state, the client host
 * stays the same).
 */
export function notifyHostReplaced(): void {
  for (const l of [...hostListeners]) {
    try {
      l();
    } catch {
      // A failing listener must not break host replacement.
    }
  }
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

/**
 * Render a TypedValue for the grid: numbers as-is, errors show their code,
 * empty cells render as ''. Booleans use Excel-style TRUE/FALSE.
 *
 * Numbers use Excel's General format (~10 significant digits, scientific
 * for very large/small magnitudes) rather than the full float repr, so
 * 2082088.1744066 displays as "2082088.174" like Excel.
 */
export function formatDisplay(v: TypedValue): string {
  // #PERM! renders as blank: a hidden/denied cell must not even reveal that
  // something is there (protection face e). The value is still #PERM! in
  // the protocol so MCP clients and formulas see the denial explicitly.
  if (v.kind === 'error') return v.code === '#PERM!' ? '' : v.code;
  // In-cell image (IMAGE function): text surfaces (copy, aria labels) carry
  // the alt text; the grid renders the <img> itself.
  if (v.kind === 'image') return v.alt;
  const value = v.value;
  if (typeof value === 'number') return formatWithCode(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '';
}

// ---------------------------------------------------------------------------
// Edit parsing
// ---------------------------------------------------------------------------

export type ParsedEdit = { kind: 'formula'; formula: string } | { kind: 'value'; value: CellInput };

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Parse raw editor text into a protocol-level edit.
 * A leading '=' makes it a formula; otherwise coerce numbers and booleans,
 * keep everything else as a string, and map empty input to null (clears).
 */
export function parseEdit(text: string): ParsedEdit {
  const trimmed = text.trim();
  if (trimmed.startsWith('=')) {
    return { kind: 'formula', formula: trimmed };
  }
  if (trimmed === '') {
    return { kind: 'value', value: null };
  }
  if (NUMERIC_RE.test(trimmed)) {
    return { kind: 'value', value: Number(trimmed) };
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'true') return { kind: 'value', value: true };
  if (lower === 'false') return { kind: 'value', value: false };
  return { kind: 'value', value: text };
}

// ---------------------------------------------------------------------------
// Addressing helpers
// ---------------------------------------------------------------------------

/** Column label for 0-based index: 0 -> 'A', 25 -> 'Z'. */
export function colLabel(col: number): string {
  let label = '';
  let n = col;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** Short A1 address without sheet prefix, e.g. (0,0) -> 'A1'. */
export function a1Short(row: number, col: number): string {
  return `${colLabel(col)}${row + 1}`;
}

/** Build a CellRef for the active sheet. */
export function cellRef(sheet: string, row: number, col: number): CellRef {
  return { sheet, row, col };
}

export type { CalculationMode, CellRef, TypedValue };
