import React, { Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { stampBuildInfo } from './services/buildInfo';
import { initTheme, applyThemeChoice } from './product/userSettings';
import { storedProfileTheme } from './settings';

// Make the baked build configuration detectable (console + <html>
// data attributes) before anything renders — a misbuilt dist must be
// obvious to a harness in seconds, not discovered mid-matrix.
stampBuildInfo();

// Theme (workspace-settings brief): set <html data-theme> before first
// paint, in EVERY host mode (gateway web, local web, desktop). When a
// profile is already stored on this browser its theme IS the last-known
// choice (the gateway shell mirrors the authoritative server choice into
// it whenever settings land), so paint that; the shell re-applies the
// server choice when it arrives. Only a first-ever run falls back to
// resolving the 'system' default (#38: no wrong-theme flash on refresh).
const bootTheme = storedProfileTheme();
if (bootTheme) applyThemeChoice(bootTheme);
else initTheme();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Missing #root element');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {/*
      Encrypted service stores (sensitivity labels, named ranges/functions,
      access table, ETL version history) are created asynchronously on first
      render (WebCrypto); the app suspends until they resolve.
    */}
    <Suspense
      fallback={
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
          Loading Icecream Sheets…
        </div>
      }
    >
      <App />
    </Suspense>
  </React.StrictMode>,
);
