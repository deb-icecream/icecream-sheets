"use strict";
/**
 * Fallback renderer page, shown when apps/web/dist/index.html is missing.
 *
 * It is a real page, not a dead end: it explains what is missing, how to
 * build it, and — because the preload bridge is still active — it queries
 * the main-process engine for its protocol version to prove the IPC bridge
 * works even without the web UI.
 *
 * Pure function (no Electron imports) so it can be unit-tested with node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFallbackHtml = getFallbackHtml;
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function getFallbackHtml(protocolVersion) {
    const version = escapeHtml(String(protocolVersion));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Icecream Sheets — Web UI not built</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; margin: 0; background: #f5f5f4; color: #1c1917;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #f5f5f4; }
    code { background: #44403c; }
    .card { background: #292524; border-color: #44403c; }
  }
  .card {
    max-width: 560px; padding: 32px 36px; background: #ffffff;
    border: 1px solid #e7e5e4; border-radius: 12px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.06);
  }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { line-height: 1.55; margin: 0 0 12px; }
  code { background: #f5f5f4; padding: 2px 6px; border-radius: 6px; font-size: 13px; }
  pre {
    background: #1c1917; color: #f5f5f4; padding: 14px 16px;
    border-radius: 8px; overflow-x: auto; font-size: 13px;
  }
  .status { font-size: 13px; opacity: 0.85; }
  .ok { color: #15803d; font-weight: 600; }
  .missing { color: #b45309; font-weight: 600; }
</style>
</head>
<body>
  <div class="card">
    <h1>🧊 Icecream Sheets</h1>
    <p>
      The desktop shell is running, but the web UI bundle was not found.
      Expected at <code>apps/web/dist/index.html</code> (relative to the
      desktop package).
    </p>
    <p>Build it with:</p>
    <pre>cd apps/web && npm run build</pre>
    <p>Then choose <b>View → Reload</b> (or restart the app).</p>
    <p class="status" id="bridge-status">Checking engine bridge…</p>
    <p class="status">Engine protocol version (compiled in): <b>${version}</b></p>
  </div>
  <script>
    (function () {
      var el = document.getElementById('bridge-status');
      function set(text, cls) {
        el.innerHTML = text;
        el.className = 'status ' + cls;
      }
      try {
        // The fallback page has no menu/OS-event listeners, but it still
        // signals ready so queued main→renderer messages flush instead of
        // piling up (GAP-9).
        try {
          if (window.icecreamDesktop && typeof window.icecreamDesktop.signalReady === 'function') {
            window.icecreamDesktop.signalReady();
          }
        } catch (err) { /* readiness is best-effort on the fallback page */ }
        if (window.icecream && typeof window.icecream.protocolVersion === 'function') {
          window.icecream.protocolVersion().then(function (v) {
            set('Engine bridge: <span class="ok">reachable</span> — live protocol version is ' + v + '.', 'ok');
          }).catch(function (err) {
            set('Engine bridge: <span class="missing">error</span> — ' + String((err && err.message) || err), 'missing');
          });
        } else {
          set('Engine bridge: <span class="missing">not exposed</span> (window.icecream missing).', 'missing');
        }
      } catch (err) {
        set('Engine bridge: <span class="missing">error</span> — ' + String((err && err.message) || err), 'missing');
      }
    })();
  </script>
</body>
</html>`;
}
//# sourceMappingURL=fallback.js.map