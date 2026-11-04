/**
 * Save-gate UI tests (Cycle 10: mutation is gated at 100% load).
 * The status bar's save segment must render DISABLED "Loading…" with the
 * reason while the workbook is loading — the visible half of the gate
 * (the behavior half — buildDownloadBytes/autosave/PDF throwing — lives
 * in App and is covered by the gateway-mode E2E screenshot pass).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBar from './StatusBar';

describe('StatusBar save segment (Cycle 10 save gating)', () => {
  it('shows disabled "Loading…" with the reason while the workbook loads', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        protocolVersion={1}
        calcMode="automatic"
        address="A1"
        lastError={null}
        saveState="saved"
        workbookLoaded={false}
      />,
    );
    expect(html).toContain('Loading…');
    expect(html).toContain(
      'Workbook is still loading — save is disabled until the load completes',
    );
    // The saved-state label must not show during load.
    expect(html).not.toContain('Saved');
  });

  it('shows the normal saved state once loaded', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        protocolVersion={1}
        calcMode="automatic"
        address="A1"
        lastError={null}
        saveState="saved"
        workbookLoaded={true}
      />,
    );
    expect(html).toContain('Saved');
    expect(html).not.toContain('Loading…');
  });

  it('shows live stream percentage while loading (Phase 4 progress)', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        protocolVersion={1}
        calcMode="automatic"
        address="A1"
        lastError={null}
        saveState="saved"
        workbookLoaded={false}
        loadProgressPct={45}
      />,
    );
    expect(html).toContain('Loading… 45%');
    expect(html).not.toContain('Saved');
  });

  it('shows "Calculating…" distinctly when data is in but calc lags', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        protocolVersion={1}
        calcMode="automatic"
        address="A1"
        lastError={null}
        saveState="saved"
        workbookLoaded={false}
        loadProgressPct={100}
        loadCalculating={true}
      />,
    );
    expect(html).toContain('Calculating…');
    // A stuck percentage would read "Loading… 100%" — that must not render.
    expect(html).not.toContain('Loading… 100%');
  });

  it('flips percent → ready in one transition at 100% (workbookLoaded)', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        protocolVersion={1}
        calcMode="automatic"
        address="A1"
        lastError={null}
        saveState="saved"
        workbookLoaded={true}
        loadProgressPct={null}
        loadCalculating={false}
      />,
    );
    expect(html).toContain('Saved');
    expect(html).not.toContain('Loading…');
    expect(html).not.toContain('Calculating…');
  });
});

describe('StatusBar connection segments (Phase 2 §7 vs idle rule)', () => {
  const base = {
    protocolVersion: 1,
    calcMode: 'automatic' as const,
    address: 'A1',
    lastError: null,
    saveState: 'saved' as const,
    workbookLoaded: true,
  };

  it('offline (transport drop) shows the automatic-reconnecting notice, NOT the idle banner', () => {
    const html = renderToStaticMarkup(<StatusBar {...base} offline={true} />);
    expect(html).toContain('Offline — reconnecting…');
    expect(html).not.toContain('Disconnected — idle');
  });

  it('offline notice carries NO manual reconnect button (#100: reconnection is automatic)', () => {
    const html = renderToStaticMarkup(
      <StatusBar {...base} offline={true} onReconnect={() => undefined} />,
    );
    expect(html).not.toContain('Reconnect now');
    expect(html).not.toContain('session-reconnect');
  });

  it('idle release shows the gating banner and suppresses the offline notice', () => {
    const html = renderToStaticMarkup(
      <StatusBar {...base} offline={true} sessionDisconnected={true} />,
    );
    expect(html).toContain('Disconnected — idle');
    expect(html).not.toContain('Offline — reconnecting…');
  });

  it('neither flag → no connection segment', () => {
    const html = renderToStaticMarkup(<StatusBar {...base} />);
    expect(html).not.toContain('Offline — reconnecting…');
    expect(html).not.toContain('Disconnected — idle');
  });
});

describe('StatusBar collaborators roster (#8 residual)', () => {
  const base = {
    protocolVersion: 1,
    calcMode: 'automatic' as const,
    address: 'A1',
    lastError: null,
    saveState: 'saved' as const,
    workbookLoaded: true,
  };
  it('renders display names — self as name + (You) — and never a raw principal', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        {...base}
        collaborators={[
          { principal: 'user:abc123uid', name: 'Alice A', isSelf: true, color: '#2563eb', sheet: 'Data', selection: { row: 0, col: 0 }, updatedAt: 0 },
          { principal: 'user:def456uid', name: 'Bob B', color: '#dc2626', sheet: 'Data', selection: { row: 1, col: 1 }, updatedAt: 0 },
          { principal: 'user:ghi789uid', color: '#16a34a', sheet: 'Data', selection: { row: 2, col: 2 }, updatedAt: 0 },
        ]}
      />,
    );
    expect(html).toContain('Alice A (You)');
    expect(html).toContain('Bob B');
    // A participant without a payload name falls back to the neutral
    // label — the raw principal/UID renders NOWHERE (label or tooltip).
    expect(html).toContain('Guest');
    expect(html).not.toContain('user:abc123uid');
    expect(html).not.toContain('user:def456uid');
    expect(html).not.toContain('user:ghi789uid');
  });
});
