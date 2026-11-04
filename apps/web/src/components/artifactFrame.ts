/**
 * Headless helper for the embedded artifact viewer (ArtifactHost.tsx).
 *
 * buildArtifactSrcDoc builds the sandboxed iframe document. The iframe
 * gets React + ReactDOM (inlined UMD, so it works offline), the MCP
 * bridge prelude (`window.mcp`), and the generated `function App()`
 * source — plain JS with React.createElement only, no JSX, no build
 * step. `sandbox="allow-scripts"` (set by the component) keeps the
 * iframe at an opaque origin: its only channel to the host is
 * postMessage through the bridge protocol (see
 * packages/service/src/artifacts/bridge.ts).
 *
 * Pure and unit-tested here; the React component (ArtifactFrame) is a
 * thin shell over it.
 *
 * BINDING: the generation contract (artifacts/llm.ts buildPrompt) tells
 * generated apps "a global BINDING = {sheet,startRow,startCol,endRow,
 * endCol,columns} is pre-defined; use it". Template-generated sources
 * define it themselves (generator.ts bindingPrelude), but LLM-generated
 * sources do NOT — they rely on that promise. The host keeps it here:
 * when the caller passes the artifact's spec binding, the prelude
 * defines `var BINDING = …;` before the app source runs. Without this,
 * an LLM app's first `BINDING.sheet` throws ReferenceError inside its
 * effect, its read_cells call is never posted, and the app renders its
 * static chrome with an empty body (case 3b, wave-c W2).
 */
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_TAG,
  type ArtifactBinding,
} from '@icecream-sheets/service';

// ---------------------------------------------------------------------------
// Sandbox document builder
// ---------------------------------------------------------------------------

export interface ArtifactRuntimeScripts {
  reactUmd: string;
  reactDomUmd: string;
}

/**
 * Phase 1 design system: the host's resolved theme ('light' | 'dark',
 * from <html data-theme>) maps to the iframe stylesheet's DaisyUI theme
 * names. The iframe document always carries data-theme so generated apps
 * follow the host instead of always rendering light.
 */
export const IFRAME_THEME_MAP = {
  light: 'icecream-light',
  dark: 'icecream-dark',
} as const;

export type HostTheme = keyof typeof IFRAME_THEME_MAP;

export interface ArtifactSrcDocOptions {
  /** Compiled iframe stylesheet (Tailwind + DaisyUI, Phase 1). Empty = no design-system styles (stored old-shape apps render on inline styles alone). */
  css?: string;
  /** Host resolved theme; defaults to 'light'. */
  theme?: HostTheme;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Bridge prelude injected before the generated source. Defines window.mcp:
 * - mcp.call(tool, args): Promise — posts a bridge 'call', resolves with
 *   the host's result (rejects on error).
 * - mcp.subscribe(events, sheet, onEvents): () => void — registers an
 *   event handler through the bridge subscription protocol; returns the
 *   unsubscribe function.
 */
export const BRIDGE_PRELUDE = `
'use strict';
__BINDING_PRELUDE__
(function () {
  var TAG = ${JSON.stringify(BRIDGE_TAG)};
  var VERSION = ${BRIDGE_PROTOCOL_VERSION};
  var seq = 0;
  var pending = {};
  var handlers = {};
  function post(msg) { parent.postMessage(msg, '*'); }
  window.mcp = {
    call: function (tool, args) {
      return new Promise(function (resolve, reject) {
        var id = 'c' + (++seq);
        pending[id] = { resolve: resolve, reject: reject };
        post({ [TAG]: VERSION, id: id, kind: 'call', tool: tool, args: args || {} });
      });
    },
    subscribe: function (events, sheet, onEvents) {
      var subKey = 's' + (++seq);
      handlers[subKey] = onEvents;
      // Normalize the event-name alias generated apps commonly guess:
      // the MCP subscribe tool validates against its enum
      // ('cells_changed', 'recalc_complete', 'sheet_added',
      // 'sheet_removed') and rejects 'cell_changed' outright, which
      // would silently kill the live binding (bridge host swallows the
      // failed subscribe). Canonicalize here so stored apps heal too.
      var normalized = (events || []).map(function (e) {
        return e === 'cell_changed' ? 'cells_changed' : e;
      });
      post({ [TAG]: VERSION, kind: 'subscribe', subKey: subKey, events: normalized, sheet: sheet });
      var unsub = function () {
        delete handlers[subKey];
        post({ [TAG]: VERSION, kind: 'unsubscribe', subKey: subKey });
      };
      // Both cleanup conventions work: templates return the function
      // itself as their effect cleanup, while LLM apps keep the return
      // value and call subscription.unsubscribe() in their cleanup.
      unsub.unsubscribe = unsub;
      return unsub;
    }
  };
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m[TAG] !== VERSION) return;
    if (m.kind === 'result') {
      var p = pending[m.id];
      if (p) {
        delete pending[m.id];
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(m.error || 'bridge call failed'));
      }
    } else if (m.kind === 'event') {
      var h = handlers[m.subKey];
      if (h) { try { h(m.events || []); } catch (e) { /* app handler error */ } }
    }
  });
  var h = React.createElement;
  // #144: generated code sometimes destructures 'h' from React
  // (const { ..., h } = React), which shadows the 'h' parameter above
  // with undefined — React has no 'h' export — and the app crashes on
  // mount with "h is not a function". Alias it on React itself so the
  // destructure yields the real function; this also heals apps stored
  // before the generator guard in artifacts/llm.ts. Contained: this
  // React is the iframe's own inlined UMD copy, not the host's.
  if (React && !React.h) { React.h = React.createElement; }
  try {
    var App = new Function(
      'React', 'h', 'useState', 'useEffect', 'useRef', 'mcp',
      __APP_SOURCE__ + '\\n;return App;'
    )(React, h, React.useState, React.useEffect, React.useRef, window.mcp);
    ReactDOM.createRoot(document.getElementById('root')).render(h(App));
  } catch (err) {
    document.getElementById('root').innerHTML =
      '<div class="ice-app-error">App failed to start: ' +
      String((err && err.message) || err).replace(/&/g, '&amp;').replace(/</g, '&lt;') +
      '</div>';
  }
})();
`;

/**
 * Build the full iframe srcDoc for an artifact. Throws when the source
 * contains "</script" (it would break out of the embedding script block —
 * the generator already rejects this; this is the second gate).
 */
export function buildArtifactSrcDoc(
  source: string,
  runtime: ArtifactRuntimeScripts,
  title?: string,
  binding?: ArtifactBinding,
  opts?: ArtifactSrcDocOptions,
): string {
  if (source.includes('</script')) {
    throw new Error('artifact source must not contain "</script"');
  }
  if (!runtime.reactUmd || !runtime.reactDomUmd) {
    throw new Error('artifact runtime scripts (React UMD) are required');
  }
  // The host-defined BINDING global (see the module doc): the spec's
  // binding, JSON-encoded with '<' escaped so a sheet name can never
  // break out of the script block. Template sources define their own
  // function-scoped `var BINDING` inside the app source, which simply
  // shadows this global with identical values.
  const bindingPrelude = binding
    ? 'var BINDING = ' +
      JSON.stringify({
        sheet: binding.sheet,
        startRow: binding.startRow,
        startCol: binding.startCol,
        endRow: binding.endRow,
        endCol: binding.endCol,
        columns: binding.columns.map((c) => ({
          name: c.name,
          type: c.type,
          index: c.index,
        })),
      }).replace(/</g, '\\u003c') +
      ';'
    : '';
  // The generated source is embedded as a JS string literal inside the
  // prelude: JSON-encode it so quotes/newlines cannot break out.
  const prelude = BRIDGE_PRELUDE.replace('__BINDING_PRELUDE__', bindingPrelude).replace(
    '__APP_SOURCE__',
    JSON.stringify(source),
  );
  const iframeTheme = IFRAME_THEME_MAP[opts?.theme ?? 'light'];
  const iframeCss = opts?.css ?? '';
  return (
    '<!DOCTYPE html><html data-theme="' + iframeTheme + '"><head><meta charset="utf-8">' +
    '<title>' + escapeHtml(title ?? 'App') + '</title>' +
    '<style>' +
    // Base colors follow the DaisyUI theme variables when the design
    // stylesheet is present; the fallbacks keep old-shape apps (no css)
    // rendering exactly as before.
    'html,body{margin:0;padding:0;background:var(--color-base-100,#fff);color:var(--color-base-content,#1c2530);}' +
    '#root{min-height:100%;}' +
    '.ice-app-error{color:#a00;background:#fee;padding:12px;font:13px system-ui,sans-serif;white-space:pre-wrap;}' +
    '</style>' +
    (iframeCss ? '<style>' + iframeCss + '</style>' : '') +
    '</head><body><div id="root"></div>' +
    '<script>' + runtime.reactUmd + '</script>' +
    '<script>' + runtime.reactDomUmd + '</script>' +
    '<script>' + prelude + '</script>' +
    '</body></html>'
  );
}
