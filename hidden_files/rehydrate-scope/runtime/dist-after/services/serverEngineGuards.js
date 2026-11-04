/**
 * Server engine host guards — F-11 (security pass, Critical).
 *
 * The batch-11 formula functions (extended-functions11.ts in the engine)
 * reach OUT of the workbook by design, through host provider seams whose
 * ENGINE defaults are live executors:
 *
 *   - PY() runs file-supplied Python: getPythonProvider() falls back to
 *     a Node provider that spawns `python3` with the formula's code
 *     (prelude allowlists `io` — arbitrary file write + host env read,
 *     probe-confirmed in the security pass).
 *   - WEBSERVICE() (and the IMPORTDATA/IMPORTFEED/IMPORTHTML/IMPORTXML
 *     family, which shares fetchUrlText) fetches a formula-supplied URL:
 *     the default spawns `curl` from the engine process (SSRF from a
 *     file-borne formula).
 *   - STOCKHISTORY()/GOOGLEFINANCE fetch live market data: the default
 *     market provider spawns `curl` to stooq.com on a cache miss — a
 *     network call triggered by a file-borne formula. (The server host
 *     never publishes market history, so its cache is always empty and
 *     every call would take the live-fetch path.)
 *
 * A workbook is DATA, not code: on the multi-tenant server, opening or
 * recalculating an attacker's file must never execute code, spawn a
 * process, or make a network call in the engine's identity. This module
 * installs DENYING providers for all three seams. It is called ONLY by
 * the server engine host (bin/engine.ts). Desktop and local/in-process
 * hosts never call it — PY and friends keep working there exactly as
 * before, and the service-side data-analysis Python component (a
 * product feature acting on user intent, not file-borne formulas) is a
 * different component and is untouched.
 *
 * Reviewed and deliberately NOT gated here:
 *   - CALL / REGISTER.ID execute only JS functions a HOST registered
 *     via registerExternalFunction(). No code in the gateway, service,
 *     or apps registers any (grep-verified 2026-10-22), so in the server
 *     process the registry is empty and both functions can only return
 *     their "no external function" error; REGISTER.ID also refuses DLL
 *     modules by construction. NOTE: any future server-host feature
 *     that registers external functions re-opens CALL by name — revisit
 *     this file before doing that.
 *   - COPILOT's default provider is a deterministic local analysis of
 *     the supplied context (no exec, no network, no spawn); a live
 *     provider is host configuration, not file input.
 *   - RTD reads an in-process topic bus; it executes nothing.
 *
 * Until a real out-of-process sandbox exists for server-side PY, the
 * denying provider below is the posture: PY cells evaluated by the
 * server engine return the disabled error and spawn no process.
 */
import { setMarketDataProvider, setPythonProvider, setWebFetchProvider, } from '@icecream-sheets/engine';
export const PY_DISABLED_ON_SERVER = 'PY disabled on server';
export const WEBSERVICE_DISABLED_ON_SERVER = 'WEBSERVICE disabled on server';
export const MARKET_FETCH_DISABLED_ON_SERVER = 'STOCKHISTORY/GOOGLEFINANCE live market-data fetch disabled on server';
let installed = false;
/**
 * Install the denying batch-11 providers for this process. Idempotent.
 * Call once at server engine host startup, before the listener serves.
 */
export function installServerEngineGuards() {
    if (installed)
        return;
    installed = true;
    // PY(): file-borne Python never runs on the server. This seam is also
    // the one named Python functions resolve through (getPythonProvider),
    // so they are denied by the same install.
    setPythonProvider({ run: () => ({ error: PY_DISABLED_ON_SERVER }) });
    // WEBSERVICE + IMPORT* family: no formula-driven fetches (curl) from
    // the server engine.
    setWebFetchProvider(() => {
        throw new Error(WEBSERVICE_DISABLED_ON_SERVER);
    });
    // STOCKHISTORY / GOOGLEFINANCE: no live market-data fetch (curl) from
    // the server engine.
    setMarketDataProvider({
        getHistory: () => {
            throw new Error(MARKET_FETCH_DISABLED_ON_SERVER);
        },
    });
}
