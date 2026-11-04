# icecream-sheets-desktop

Electron desktop shell for **Icecream Sheets** (Phase 5).

The shell is deliberately thin:

- **Main process** (`src/main.ts`) hosts exactly **one** `EngineHost` from
  `@icecream-sheets/engine` and exposes it to the UI over a small, validated
  IPC surface. All engine mutations go through `engine:execute`; reads through
  `engine:readCell` / `engine:readRange` / `engine:snapshot`.
- **Preload** (`src/preload.ts`) exposes that surface as `window.icecream`
  via `contextBridge`. The renderer runs with `contextIsolation: true` and
  `nodeIntegration: false` — no Node APIs leak into web content.
- **Renderer** is the web app from `apps/web/dist/index.html` (built by the
  web phase). If that file is missing, the shell shows a fallback page that
  explains how to build it — and the fallback page still calls
  `window.icecream.protocolVersion()` to prove the engine bridge is alive.

## IPC contract

| Channel                 | Arguments                          | Returns                          |
|-------------------------|------------------------------------|----------------------------------|
| `engine:execute`        | `EngineCommand`                    | `Promise<CommandResult>`         |
| `engine:readCell`       | `CellRef` `{sheet,row,col}`        | `Promise<TypedValue>`            |
| `engine:readRange`      | `RangeRef`                         | `Promise<TypedValue[][]>`        |
| `engine:snapshot`       | —                                  | `Promise<WorkbookSnapshot>`      |
| `engine:protocolVersion`| —                                  | `Promise<number>`                |

Renderer calls go through `window.icecream.*` (see `src/renderer.d.ts`).
The main process validates every inbound payload (command names against the
known protocol set, refs against `{sheet,row,col}` shapes) and converts
engine throws into `{ ok: false, error }` results instead of crashing IPC.

Not yet exposed (future work): `subscribe` engine events → renderer push
(`cellsChanged` / `recalcComplete` / `sheetAdded`). The renderer currently
polls via `readCell`/`snapshot`.

## Run

```sh
# from the repo root (npm workspaces)
npm install
npm run build -w icecream-sheets-desktop

# the web UI must exist for the full experience (built by the web phase)
# cd ../web && npm run build

npm start -w icecream-sheets-desktop
```

`npm start` needs a display. On a headless Linux box the app cannot open a
window, but `npx electron --version` and the `dist:win` / `dist:mac` packaging
steps below work headless.

## Installers

```sh
npm run dist:win   # Windows NSIS installer -> apps/desktop/dist/*.exe
npm run dist:mac   # macOS zip               -> apps/desktop/dist/*.zip
```

Built 2026-10-18 (both `EXIT: 0` on Linux):

- `dist/IcecreamSheets Setup 0.1.0.exe` (160 MB) — NSIS-3 Unicode installer,
  verified with 7-Zip: 77 files, `resources/app.asar` (12 MB, contains the
  web UI + engine), embedded `Uninstall.exe`. Unsigned — Windows SmartScreen
  will warn on first run.
- `dist/IcecreamSheets-0.1.0-mac.zip` (385 MB) — unsigned `IcecreamSheets.app`
  (x64). macOS Gatekeeper will block it on first launch; right-click → Open
  to run once. A signed, notarized DMG needs a Mac + Apple Developer cert.

`files` bundles the compiled `dist/*.js` (main + preload) and
`../web/dist/**` (the web UI) when it exists. If the web app has not been
built yet, packaging still succeeds — the installed app then shows the
fallback page until the web bundle is added.

Build notes (deviations from the naive config, both forced by tooling):

- `electron` lives in **devDependencies**, not `dependencies`: electron-builder
  hard-fails otherwise (`Package "electron" is only allowed in
  "devDependencies"`). This is also the correct placement — the packaged app
  bundles its own Electron runtime; the npm package is only the dev/download
  shim.
- `electron` is pinned to an **exact version** (`44.9.0`, not `^44.0.0`):
  electron-builder refuses ranges because it must download platform binaries
  for one specific release.
- Linux builds of the Windows NSIS target: electron-builder's **stock** NSIS
  flow *executes* the freshly built installer under **wine** to generate the
  uninstaller exe — and wine is unusable in this container (distro wine 9.0
  segfaults; electron-builder's own wine 11.0 bundle fails to initialise with
  `c0000135`). So the build uses a **custom NSIS script**
  (`build/installer.nsi`, wired via `nsis.script`) that uses NSIS's native
  `WriteUninstaller` instead — no wine involved at any step. The script is a
  clean per-user (no-UAC) installer: MUI welcome/directory/install/finish
  pages, Start Menu + desktop shortcuts, Add/Remove Programs registration,
  and a working `Uninstall.exe`. (Trade-off vs stock: no differential-update
  blockmap embedding or one-click/per-machine modes — fine for 0.1.0.)
- `files` uses the **object form** `{ "from": "../web/dist", "to": "web/dist" }`
  for the web UI: a plain `"../web/dist/**/*"` string is a dead pattern —
  electron-builder roots its file walker at the project dir, so `..` segments
  can never match. Verified against app-builder-lib's `AppFileWalker`.
- `files` uses `"dist/*.js"` (not `"dist/**/*"`): the broad pattern plus
  `!`-negations did **not** exclude `dist/win-unpacked/` in practice (a
  630 MB self-including asar was observed), so the config now positively
  selects only the compiled entry points. The `!dist/*` negations are kept
  as belt-and-braces.
- Do **not** add `SetCompressor /SOLID lzma` to the NSIS script: makensis
  dies with SIGBUS on solid compression of this app's file tree in Linux
  containers (bisected empirically). The default zlib compressor is used;
  the installer is ~160 MB.
- `TMPDIR` should point at a roomy filesystem when building: makensis uses
  temp space while compressing, and this container's `/tmp` is a 512 MB
  tmpfs (exhaustion also manifests as makensis SIGBUS).

- **Windows (NSIS):** builds on Linux via the custom `build/installer.nsi`
  (see build notes). The installer is **unsigned** (no certificate in this
  environment); Windows SmartScreen will warn on first run.
- **macOS (zip):** the config deliberately targets `zip`, not DMG: a signed,
  notarized DMG requires a Mac with Xcode and an Apple Developer certificate,
  which this Linux build environment does not have. The zip contains an
  unsigned `.app`; on first launch macOS Gatekeeper will block it — right-click
  → Open to run it once, after which it is trusted.

## Menu honesty

The File menu contains **New Workbook** (resets the in-memory engine and
reloads) and **Quit**. **Open/Save .xlsx are intentionally omitted**: the
`@icecream-sheets/xlsx-adapter` package is still a stub in this phase and the
engine exposes JSON snapshots only, so there is no real .xlsx persistence to
wire up. They will be added with the storage phase rather than shipping dead
menu items. Edit (Undo/Redo/Cut/Copy/Paste/SelectAll) and View
(Reload/Toggle DevTools) use native Electron roles.

## Limitations

- One workbook at a time; no tabs or multi-window support.
- No persistence yet — quitting discards the workbook (see menu honesty).
- No engine event push to the renderer (poll via snapshot/reads).
- No auto-updater, no crash reporter.
- Unsigned installers (see above).
