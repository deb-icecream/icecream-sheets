"use strict";
/**
 * Icecream Sheets — preload script.
 *
 * Runs in the isolated preload context. Its only job is to expose the
 * validated engine IPC surface as `window.icecream` (the user's workbook
 * lives in the main-process engine; Cycle 10 engine/view separation) and
 * the desktop shell API as `window.icecreamDesktop` via contextBridge.
 * No Node APIs leak into the renderer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const icecreamApi = {
    execute: (command) => electron_1.ipcRenderer.invoke('engine:execute', command),
    readCell: (ref) => electron_1.ipcRenderer.invoke('engine:readCell', ref),
    readRange: (range) => electron_1.ipcRenderer.invoke('engine:readRange', range),
    usedRange: (sheet) => electron_1.ipcRenderer.invoke('engine:usedRange', sheet),
    snapshot: () => electron_1.ipcRenderer.invoke('engine:snapshot'),
    protocolVersion: () => electron_1.ipcRenderer.invoke('engine:protocolVersion'),
    load: (bytes, filename) => electron_1.ipcRenderer.invoke('engine:load', { bytes, filename }),
    newWorkbook: () => electron_1.ipcRenderer.invoke('engine:new'),
    setProtection: (state) => electron_1.ipcRenderer.invoke('engine:protection', state),
    onEngineEvent: (cb) => {
        const listener = (_event, payload) => cb(payload);
        electron_1.ipcRenderer.on('icecream:engine-event', listener);
        return () => electron_1.ipcRenderer.removeListener('icecream:engine-event', listener);
    },
};
electron_1.contextBridge.exposeInMainWorld('icecream', icecreamApi);
/** Typed subscribe-to-channel helper for the new main→renderer events. */
function listen(channel, cb) {
    const listener = (_event, payload) => cb(payload);
    electron_1.ipcRenderer.on(channel, listener);
    return () => electron_1.ipcRenderer.removeListener(channel, listener);
}
const desktopApi = {
    auth: {
        login: (userId) => electron_1.ipcRenderer.invoke('auth:login', userId),
        logout: () => electron_1.ipcRenderer.invoke('auth:logout'),
        status: () => electron_1.ipcRenderer.invoke('auth:status'),
        loginWithFirebase: (idToken) => electron_1.ipcRenderer.invoke('auth:loginWithFirebase', idToken),
        openLoginWindow: () => electron_1.ipcRenderer.invoke('auth:openLoginWindow'),
        onAuthChanged: (cb) => listen('auth:changed', (payload) => cb(payload)),
    },
    svc: {
        call: (service, path, method, body) => electron_1.ipcRenderer.invoke('svc:call', { service, path, method, body }),
    },
    mcp: {
        url: () => electron_1.ipcRenderer.invoke('mcp:url'),
    },
    file: {
        pickOpen: () => electron_1.ipcRenderer.invoke('file:pickOpen'),
        saveBytes: (bytes, suggestedPath, suggestedName) => 
        // GAP-3: suggestedName pre-fills the Save dialog (export filename);
        // undefined keeps main's "workbook.xlsx" default.
        electron_1.ipcRenderer.invoke('file:saveBytes', { bytes, suggestedPath, suggestedName }),
        saveXlsxDirect: (extras, suggestedPath, suggestedName) => electron_1.ipcRenderer.invoke('engine:saveXlsxDirect', {
            extras,
            suggestedPath,
            suggestedName,
        }),
        autosaveFlush: (extras) => electron_1.ipcRenderer.invoke('engine:autosaveFlush', { extras }),
        saveStatus: () => electron_1.ipcRenderer.invoke('engine:saveStatus'),
        syncSessionExtras: (extras) => electron_1.ipcRenderer.invoke('engine:sessionExtras', { extras }),
        onMenuOpen: (cb) => {
            const listener = () => cb();
            electron_1.ipcRenderer.on('icecream:menu-open', listener);
            return () => electron_1.ipcRenderer.removeListener('icecream:menu-open', listener);
        },
        onMenuSave: (cb) => {
            const listener = () => cb();
            electron_1.ipcRenderer.on('icecream:menu-save', listener);
            return () => electron_1.ipcRenderer.removeListener('icecream:menu-save', listener);
        },
        onMenuSaveAs: (cb) => listen('icecream:menu-save-as', () => cb()),
        /**
         * Fired when File → New Workbook is picked (GAP-6 dirty guard). The
         * callback answers whether the current workbook may be discarded:
         * true when nothing is unsaved, otherwise the user's confirm answer.
         * The answer is sent back on 'icecream:confirm-new:reply'.
         */
        onConfirmNew: (cb) => {
            const listener = async () => {
                const ok = await cb();
                electron_1.ipcRenderer.send('icecream:confirm-new:reply', ok);
            };
            electron_1.ipcRenderer.on('icecream:confirm-new', listener);
            return () => electron_1.ipcRenderer.removeListener('icecream:confirm-new', listener);
        },
        onOpenPath: (cb) => listen('icecream:open-path', (payload) => {
            const info = payload;
            if (info &&
                typeof info.path === 'string' &&
                (info.bytes instanceof Uint8Array || Array.isArray(info.bytes))) {
                // Normalize the legacy number[] shape at the bridge boundary;
                // main now sends a Uint8Array (binary clone, no per-byte walk).
                cb({
                    path: info.path,
                    bytes: info.bytes instanceof Uint8Array ? info.bytes : new Uint8Array(info.bytes),
                });
            }
        }),
    },
    menu: {
        onPreferences: (cb) => listen('icecream:menu-preferences', () => cb()),
        onHelp: (cb) => listen('icecream:menu-help', () => cb()),
    },
    signalReady: () => {
        electron_1.ipcRenderer.send('renderer:ready');
    },
};
electron_1.contextBridge.exposeInMainWorld('icecreamDesktop', desktopApi);
//# sourceMappingURL=preload.js.map