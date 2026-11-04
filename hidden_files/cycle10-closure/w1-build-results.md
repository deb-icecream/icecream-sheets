# Cycle 10 Closure Pass — W1 Build Results

Date: 2026-10-20 (worker run, ~15:35–15:45 PDT)
No code changes. No git pushes.

## Job 1 — Desktop rebuild

### Package dists rebuilt from source (all `npm run build` = `tsc -p tsconfig.json`, exit 0)

| Package | Result |
|---|---|
| packages/engine | ✅ exit 0 |
| packages/xlsx-adapter | ✅ exit 0 |
| packages/gateway | ✅ exit 0 |
| packages/service | ✅ exit 0 |
| packages/mcp-server | ✅ exit 0 |

### Web dist: two flavors, ORDER MATTERS

Code reading (`apps/web/src/engine.ts` `createInitialHost`, `apps/web/src/services/gatewayClient.ts`,
`apps/web/src/App.tsx` gateway-gate at `gwClient && !gwAuthed && !isDesktop()`):

- Desktop detection is **runtime** (`isDesktop()` via `window.icecreamDesktop`, checked FIRST in
  `createInitialHost` → `IpcEngineHost`; the gateway login gate is explicitly bypassed on desktop).
- BUT `VITE_GATEWAY_URL` is **build-time** inlined by Vite. The completion pass's validated desktop
  artifact was built with NO gateway env (verified: its dist env object was
  `{BASE_URL:"./",DEV:!1,MODE:"production",PROD:!0,SSR:!1}` and the gateway env object was `{}`).
  To reproduce that validated artifact byte-for-byte in behavior, the desktop package was built
  from the no-gateway dist, and the gateway-flavored dist was rebuilt AFTER packaging.

Commands, in the order run:

```bash
# 1. Desktop-flavor web dist (no gateway env)
cd apps/web && env -u VITE_GATEWAY_URL -u VITE_MCP_URL npm run build   # tsc && vite build, exit 0
#    verified: inlined env has no VITE_GATEWAY_URL; main bundle index-LoCahREu.js

# 2. Desktop main/preload
cd apps/desktop && npm run build                                       # tsc, exit 0

# 3. Package (old dist/linux-unpacked deleted first)
cd apps/desktop && npx electron-builder --linux dir AppImage           # exit 0
#    -> dist/linux-unpacked/  +  dist/IcecreamSheets-0.1.0.AppImage
#    verified: app.asar contains /web/dist/assets/index-LoCahREu.js (the fresh desktop-flavor build)

# 4. AFTER packaging: gateway-flavor web dist for the :4173 stack
cd apps/web && VITE_GATEWAY_URL=http://127.0.0.1:8100 npm run build    # exit 0
#    verified: inlined {VITE_GATEWAY_URL:"http://127.0.0.1:8100"}; main bundle index-Q1QUgrAh.js
```

⚠️ Consequence: `apps/web/dist` on disk is now the GATEWAY flavor. The desktop package's embedded
copy (inside `app.asar`) is the DESKTOP flavor. If the desktop is ever re-packaged, re-run step 1
(desktop-flavor web build) BEFORE electron-builder, then step 4 again for the stack.

### Artifacts

| Artifact | Path | Size |
|---|---|---|
| Unpacked binary (harness path) | `apps/desktop/dist/linux-unpacked/icecream-sheets-desktop` | 229,489,992 bytes (219 MiB); whole `linux-unpacked/` dir 356 MiB |
| AppImage (single-file, for parent to git-push) | `apps/desktop/dist/IcecreamSheets-0.1.0.AppImage` | 142,326,582 bytes (136 MiB) |
| AppImage sha256 | `4a07f35a07a7f7059a277b7168dd6203622999a27a61ac553eca337f293828e0` | |

### Smoke check (packaged binary, ~20 s) — PASS

```bash
xvfb-run -a -s "-screen 0 1600x1000x24" \
  apps/desktop/dist/linux-unpacked/icecream-sheets-desktop --no-sandbox --remote-debugging-port=9222
```

- Process (main + zygote/gpu/renderer children) alive after 20 s. ✅
- Window proof via CDP `http://127.0.0.1:9222/json/list`: one page target, title **"Icecream Sheets"**,
  URL `file://…/linux-unpacked/resources/app.asar/web/dist/index.html` (packaged UI loaded, not fallback). ✅
- Desktop's own MCP ingress healthy during the run: `GET :8106/health` → `{"ok":true,"service":"mcp-server"}`;
  log lines: `[mcp] direct ingress listening`, `[parallel] worker pool enabled`, add-on service ready. ✅
- App shut down cleanly after the smoke; ports 8106/9222 free afterwards (so the stack could take 8106). ✅
- Full validation sweep NOT run (later worker's job, per task).

## Job 2 — Gateway stack (left running)

Started with `hidden_files/start-stack-finisher.sh` (engine with `--max-old-space-size=6144`,
confirmed in `ps`). Note: the script's own immediate health sweep raced startup and reported
8100/8101/8106/4173 as DOWN; a re-check seconds later shows everything up. Logs in `/tmp/gwlogs/`.

Final health table (`GET /health`, re-verified after startup settled):

| Port | Service | HTTP | Body |
|---|---|---|---|
| 8100 | gateway | 200 | `{"ok":true,"service":"gateway","routes":["/api/engine","/api/vault","/api/meta",…]}` |
| 8101 | engine | 200 | `{"ok":true,"service":"engine"}` (node pid 20569, 6 GiB heap flag) |
| 8102 | vault | 200 | `{"ok":true,"service":"vault"}` (pid 20574) |
| 8103 | meta | 200 | `{"ok":true,"service":"meta"}` (pid 20577) |
| 8104 | etl | 200 | `{"ok":true,"service":"etl"}` (pid 20580) |
| 8105 | agent | 200 | `{"ok":true,"service":"agent"}` (pid 20583) |
| 8106 | mcp-server | 200 | `{"ok":true,"service":"mcp-server"}` (pid 20592) |
| 4173 | web preview (vite, gateway-flavor dist) | 200 | serves `index.html` (200 on `/` and `/health`) |

All processes are nohup-detached and were left running.
Gateway note from its log: Firebase Google sign-in disabled (no `FIREBASE_PROJECT_ID`) — expected, keys are the user's.
