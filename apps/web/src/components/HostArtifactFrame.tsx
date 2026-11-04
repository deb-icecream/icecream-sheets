/**
 * Host-context artifact renderer (owner decision 2026-10-25: skip the
 * iframe FOR NOW; generated JSX renders in the host app context itself).
 *
 * Replaces ArtifactFrame at the single AgentChat mount point, so it
 * serves BOTH the inline panel lane and the fullscreen expansion (the
 * expansion is a CSS class on the same lane). ArtifactFrame and the
 * iframe path are KEPT for the later sandboxed step — this component
 * does not delete them.
 *
 * Styling isolation WITHOUT an iframe: the compiled Tailwind + DaisyUI
 * stylesheet is injected into a shadow root attached to the frame div,
 * so DaisyUI classes style the app while Tailwind preflight cannot leak
 * into the spreadsheet shell (grid, ribbon, chrome) — the 2026-10-25
 * scope ruling. The JavaScript still runs in the host realm (see the
 * trust note in hostJsx.ts): shadow DOM isolates styles, not code.
 *
 * Failures are never blank: transform, compile and render errors all
 * land in a visible alert box in place of the app.
 */
import { useEffect, useRef, useState } from 'react';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArtifactSpec, McpCallFn } from '@icecream-sheets/service';
import { IFRAME_THEME_MAP } from './artifactFrame';
import { useHostTheme } from './ArtifactHost';
// The compiled iframe stylesheet (Tailwind + DaisyUI, Phase 1) is
// already in the main bundle via ArtifactHost — reusing it here adds no
// startup cost. It is injected ONLY into the shadow root below, never
// into the host document.
import iframeCss from './artifact-iframe.compiled.css?raw';
import { compileAppSource, HostMcp, prepareAppSource } from './hostJsx';
import { AppChart } from './AppChart';

/**
 * Tailwind v4.3.3's non-initial --tw-* defaults, re-applied UNGATED
 * inside the shadow tree. Proven gap (2026-10-25): Tailwind's properties
 * layer assigns these inside an @supports block that is FALSE in Chrome
 * 155, and @property does not register inside a shadow tree — so the
 * variables compute empty, utilities reading them (notably .border via
 * --tw-border-style) fall back to none/0, and table borders vanish even
 * though the .border rule itself is present. This unlayered rule beats
 * the layered properties block, is scoped to this shadow tree only, and
 * must be re-checked if Tailwind is upgraded (values copied from the
 * compiled stylesheet's properties layer).
 */
const SHADOW_TW_DEFAULTS =
  '*,::before,::after,::backdrop{' +
  '--tw-border-style:solid;--tw-shadow:0 0 #0000;--tw-shadow-alpha:100%;' +
  '--tw-inset-shadow:0 0 #0000;--tw-inset-shadow-alpha:100%;' +
  '--tw-ring-shadow:0 0 #0000;--tw-inset-ring-shadow:0 0 #0000;' +
  '--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;' +
  '--tw-ring-offset-shadow:0 0 #0000;--tw-outline-style:solid;' +
  '--tw-drop-shadow-alpha:100%}';

export function HostArtifactFrame({
  spec,
  mcpCall,
}: {
  spec: ArtifactSpec;
  mcpCall: McpCallFn | null;
}) {
  const shadowHostRef = useRef<HTMLDivElement | null>(null);
  // The mount div INSIDE the shadow tree. The compiled stylesheet
  // defines theme variables ONLY under [data-theme=icecream-light/dark],
  // and a shadow-root stylesheet matches only elements inside its own
  // tree — so data-theme must live on an element inside the tree (this
  // mount div), not only on the light-DOM shadow host, or the variables
  // never resolve and DaisyUI renders unstyled. Kept in a ref so the
  // theme can be re-synced without remounting (and resetting) the app.
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hostTheme = useHostTheme();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!mcpCall) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let root: Root | null = null;
    let bridge: HostMcp | null = null;
    const hostEl = shadowHostRef.current;
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        bridge = new HostMcp(mcpCall);
        const code = await prepareAppSource(spec.source);
        const App = compileAppSource(code, {
          React,
          h: React.createElement,
          useState: React.useState,
          useEffect: React.useEffect,
          useRef: React.useRef,
          mcp: bridge.api,
          BINDING: spec.binding,
          AppChart,
        });
        if (cancelled || !hostEl) return;
        const shadow = hostEl.shadowRoot ?? hostEl.attachShadow({ mode: 'open' });
        shadow.innerHTML = '';
        const style = document.createElement('style');
        style.textContent = iframeCss;
        shadow.appendChild(style);
        const twDefaults = document.createElement('style');
        twDefaults.textContent = SHADOW_TW_DEFAULTS;
        shadow.appendChild(twDefaults);
        const mount = document.createElement('div');
        mount.setAttribute('data-theme', IFRAME_THEME_MAP[hostTheme]);
        mount.style.minHeight = '100%';
        shadow.appendChild(mount);
        mountRef.current = mount;
        root = createRoot(mount);
        root.render(React.createElement(App));
        if (!cancelled) setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      mountRef.current = null;
      try {
        root?.unmount();
      } catch {
        /* already unmounted */
      }
      bridge?.dispose();
    };
  }, [spec.id, spec.source, mcpCall]);

  // Re-sync the theme attribute when the host theme changes, without
  // remounting the app (the main effect above would reset app state).
  useEffect(() => {
    const mount = mountRef.current;
    if (mount) {
      mount.setAttribute('data-theme', IFRAME_THEME_MAP[hostTheme]);
    }
  }, [hostTheme]);

  if (!mcpCall) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: '#555' }}>
        Generated apps need the local engine — they are not available through the gateway in v1.
      </div>
    );
  }

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {loading && !error && (
        <div style={{ padding: 16, fontSize: 13, color: '#555' }}>Loading app…</div>
      )}
      {error && (
        <div
          className="host-app-error"
          role="alert"
          style={{
            margin: 12,
            padding: 12,
            borderRadius: 4,
            fontSize: 13,
            background: '#fee',
            color: '#a00',
            border: '1px solid #eaa',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {`App failed to start: ${error}`}
        </div>
      )}
      <div
        ref={shadowHostRef}
        className="host-app-root"
        data-theme={IFRAME_THEME_MAP[hostTheme]}
        style={{ flex: 1, minHeight: 0, display: loading || error ? 'none' : 'block' }}
      />
    </div>
  );
}
