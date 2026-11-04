/**
 * Renderer-side TypeScript declarations for the Electron preload bridge.
 *
 * The preload script (src/preload.ts) exposes a validated engine API as
 * `window.icecream` and the desktop shell API (file dialogs, auth, menu
 * events, service calls) as `window.icecreamDesktop` via contextBridge.
 * Import this file's types (or rely on the global Window augmentation) in
 * renderer code:
 *
 *   const v = await window.icecream.protocolVersion();
 */

import type {
  DesktopTriggersApi,
  IcecreamApi,
  IcecreamDesktopApi,
} from './preload';

declare global {
  interface Window {
    readonly icecream: IcecreamApi;
    /** Present only when running inside the Electron shell (not the web app). */
    readonly icecreamDesktop: IcecreamDesktopApi | undefined;
  }
}

/**
 * The triggers bridge typing (`window.icecreamDesktop.triggers`, desktop
 * local-mode trigger hosting) — re-exported so renderer code can name it
 * without importing the preload implementation module.
 */
export type { DesktopTriggersApi };

export {};
