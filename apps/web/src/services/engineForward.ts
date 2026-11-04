/**
 * Desktop MCP parity (platform-shell.md §8, GAP-1): renderer-side engine
 * forwarding.
 *
 * The Electron main process serves the desktop MCP direct ingress (:8106)
 * through an IpcForwardingEngineHost (apps/desktop/src/mcp-forward.ts),
 * which forwards every protocol op to THIS renderer's host — the user's
 * real workbook — over IPC ('engine:forward', correlated by id in the
 * preload script). This module registers that renderer-side handler and
 * pushes engine events back to the main process, which feeds the MCP
 * SubscriptionManager attached to the forwarding host (so third-party MCP
 * clients see live workbook changes via poll_events).
 *
 * This lives in its own module (not desktopAgent.ts) deliberately:
 * desktopAgent.ts is imported BY ../engine (isDesktop), so importing the
 * engine back from desktopAgent would create a module-evaluation cycle
 * that crashes when desktopAgent loads first. This module only depends on
 * ../engine — one direction, no cycle.
 */
import type { EngineEvent, EngineForwardPayload } from '@icecream-sheets/engine';
import { getHost, onHostReplaced } from '../engine';

/** Minimal shape of the preload bridge (see desktopAgent.ts DesktopApi). */
interface EngineForwardBridge {
  onRequest(cb: (payload: EngineForwardPayload) => Promise<unknown>): () => void;
  publishEvent(event: EngineEvent): void;
}

function bridge(): EngineForwardBridge | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { icecreamDesktop?: { engineForward?: EngineForwardBridge } })
      .icecreamDesktop?.engineForward ?? null
  );
}

/**
 * Register the renderer-side engine forward handler and start pushing
 * engine events to the main process. No-op when not running on desktop
 * (or when the preload bridge predates engineForward). Returns an
 * unsubscribe function.
 *
 * The handler delegates to getHost() on EVERY call: opening a file
 * replaces the host object (replaceHost), so the host must never be
 * cached here. Event subscriptions are re-attached on host replacement.
 */
export function registerEngineForwardHandler(): () => void {
  const fw = bridge();
  if (!fw) return () => {};
  const offRequest = fw.onRequest(async (payload: EngineForwardPayload): Promise<unknown> => {
    const host = getHost();
    switch (payload.op) {
      case 'execute':
        return host.execute(payload.command);
      case 'executeAsync':
        return host.executeAsync(payload.command);
      case 'readCell':
        return host.readCell(payload.ref, payload.auth);
      case 'readRange':
        return host.readRange(payload.range, payload.auth);
      case 'readSheet':
        return host.readSheet(payload.sheet, payload.auth);
      case 'snapshot':
        return host.snapshot();
      case 'usedRange':
        return host.getUsedRange(payload.sheet);
      default: {
        const unreachable: never = payload;
        throw new Error(`unknown engine:forward op: ${JSON.stringify(unreachable)}`);
      }
    }
  });
  const publish = (event: EngineEvent): void => {
    try {
      fw.publishEvent(event);
    } catch {
      // A failed push must never break the engine's own event flow.
    }
  };
  let offEvents = getHost().subscribe(publish);
  const offReplaced = onHostReplaced(() => {
    offEvents();
    offEvents = getHost().subscribe(publish);
  });
  return () => {
    offRequest();
    offEvents();
    offReplaced();
  };
}
