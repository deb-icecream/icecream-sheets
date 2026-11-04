# Worker C (web product UI) — build report

Date: 2026-10-21. Scope: BRIEF.md §§3–5 + CONTRACT.md §Web. NEW files only; no edits to App.tsx / main.tsx / index.css / index.html / vite.config; dist NOT rebuilt; no git push.

## Verdict: all deliverables DONE, checks green

- `npx tsc --noEmit` (apps/web): **clean, exit 0, zero errors anywhere in the tree** — no pre-existing errors to separate.
- `npx vitest run src/product`: **4 test files, 37 tests, all passed** (productApi 11, deepLink 11, Workspace 9, LandingPage 6). The `act(...)` stderr warnings are the same ones the repo's existing component tests emit (same raw react-dom/test-utils pattern; React act-environment is not configured repo-wide) — warnings only, no failures.
- Untouched-files proof: `git status` shows `?? apps/web/src/product/` as the only new path from this worker; `apps/web/dist/index.html` mtime is 22:59 UTC, before this session's first write (23:09 UTC) — dist churn belongs to the running Phase 2 coordinator, not this worker. (The broad `M` list across src/ is the repo's pre-existing uncommitted state vs the baseline commit.)

## Files created

| File | Bytes | Notes |
|---|---|---|
| apps/web/src/product/productApi.ts | 8,827 | ProductApi + UserFileRecord / FileLimits / FileListResult / MeResult / UploadGrantResult / FilePatch + ProductApiError {status, code, message} |
| apps/web/src/product/deepLink.ts | 2,460 | fileIdFromSearch / fileIdFromHash / fileIdFromUrl / buildFileUrl / stashReturnFile / takeReturnFile |
| apps/web/src/product/LandingPage.tsx | 9,151 | sections in contract order |
| apps/web/src/product/Workspace.tsx | 14,293 | full workspace per contract |
| apps/web/src/product/product.css | 10,220 | every selector `.ics-`-prefixed/scoped (grep-verified); stacks under 720px |
| apps/web/src/product/productApi.test.ts | 9,065 | fake GatewayClient at the `call()` funnel |
| apps/web/src/product/deepLink.test.ts | 2,934 | |
| apps/web/src/product/LandingPage.test.tsx | 5,054 | repo's raw react-dom pattern (no testing-library in this repo) |
| apps/web/src/product/Workspace.test.tsx | 8,812 | fake ProductApi via vi.fn stubs |
| apps/web/public/product/hero-dashboard.png | 140,086 | ← hidden_files/direct-save-pass/tour-p75/p75ds-sheet-12-Dashboard.png |
| apps/web/public/product/pivotchart.png | 149,061 | ← hidden_files/cycle10-completion-shots/pivotchart-loaded.png |
| apps/web/public/product/collab.png | 71,523 | ← hidden_files/phase2-coauthoring/leg-a/shots/s02-alice-converged.png |

Images: all ≤ ~149 KB — **none exceeds 1.5 MB**, no re-encoding needed or done.

## Per-deliverable notes

1. **productApi.ts** — All /api/files* traffic goes through `GatewayClient.call`. `uploadFile(file)` = `uploadGrant` → raw `fetch` PUT of the File to the grant's signed URL with **no gateway auth headers** (test asserts `authorization` is undefined and the body is the File) → `completeUpload`. **Error path:** the real GatewayClient flattens gateway error JSON into `Error("gateway <status>: <body>")`; ProductApi unwraps that shape and re-parses the body so `ProductApiError.message` is the server's `error` string **verbatim** and `code` survives (tests assert exact string equality for 413 UPLOAD_TOO_LARGE and 409 FILE_LIMIT_REACHED, using gateway-style thrown errors, not idealized ones). 401/429 map from GatewayAuthError/GatewayRateLimitError. A failed staging PUT parses the staging body's error JSON the same verbatim way.
2. **deepLink.ts** — search param wins over legacy `#file=` hash (tested); stash key `icecream-sheets.return-file`; `takeReturnFile` is read-once (tested: second take returns null).
3. **LandingPage.tsx** — nav (wordmark "Icecream Sheets"; right side is "Open workspace" when `loggedIn`, else "Sign in"), hero (two-pillar standfirst, `/product/hero-dashboard.png` with descriptive alt, primary CTA), AI-native section (`/product/collab.png`; agent as first-class user via MCP, explicitly "not a chatbot bolted on"), Data-native section (`/product/pivotchart.png`; native processing/visualization, spreadsheet as a view over data sources, "not just a file editor"), 6-item capabilities strip with inline SVG icons, Default vs Pro cards with headings **exactly** "Default"/"Pro" (Default: ~1.3 MB uploads, up to 10 files, create files of any size; Pro: unrestricted), footer. The word "free" appears **nowhere** in the page — grep-verified in source and asserted on rendered text in tests. Buttons are `<button>`, semantic heading order h1→h2→h3, all images carry real alt text.
4. **Workspace.tsx** — header "Icecream Sheets Workspace" + tier badge (exactly "Default"/"Pro" from the listFiles result) + Default meter "N of 10 files" (uses `count` and `limits.fileLimit`, falls back to 10); Pro shows "Unlimited files", no cap framing. Recents = first 5 of the API's recents-ordered list (tested: 7-file fixture → 5 recents in order, 7 table rows). All-files table: name / formatted size / relative modified time / origin tag "Uploaded"|"Created" / actions. File names are real `<a href={buildFileUrl(fileId)}>` (tested href contains `?file=<id>`); with a custom `onOpenFile`, anchor clicks preventDefault and call it (tested); without one, anchors navigate natively and create uses `window.location.assign(buildFileUrl(id))`. Upload via hidden file input; a ProductApiError renders `error.message` **verbatim** as the sole content of `role="alert"` (tested with exact equality). New spreadsheet = name field + button → createFile → onOpenFile (tested end-to-end). Download (downloadGrant → window.open), inline Rename (→ renameFile → refresh), Delete (window.confirm → deleteFile → refresh), empty state with create/upload CTAs, loading state, and load-error alert with retry.
5. **product.css** — scoped `.ics-` only (no global element selectors); palette/type echo index.css (accent #0e7c6b, panel/line/text tokens, 6px radius, system stack) without importing it; hero gradient + screenshot shadow treatment, tier cards (Pro accent-highlighted), table styles, 720px stacking breakpoint.

## Interpretations / deviations (flagged, none silent)

- **`me()`**: CONTRACT.md lists the method but defines no `/api/me` endpoint. Implemented over `GET /api/files`, returning `{ tier, limits, count }` (MeResult). If Worker A's gateway grows a dedicated endpoint, this is a one-line change.
- **Timestamps**: contract doesn't pin the JSON type for createdAt/updatedAt/lastOpenedAt; typed as epoch-ms `number`, matching the repo's existing record conventions (e.g. gateway library entries). Workspace formatters assume numbers.
- **"Name prompt"**: CONTRACT.md §Web says "name prompt" for New spreadsheet; the tasking specified "name field + button" — implemented the tasking version (inline field + button in the actions bar).
- Landing/Workspace are **not mounted anywhere yet** (integration into App routing is the coordinator's later step, per constraints) — they are standalone-renderable and fully tested in isolation.

## NOT done + reason

- **Rendered-page screenshot self-inspection** (BRIEF §5 asks for desktop/narrow screenshots of the landing page): not run — this worker has no live-browser access and was forbidden from rebuilding dist / touching the running app. The components are unit-verified instead; the coordinator's local-stack validation should screenshot them once integrated.
- **Live end-to-end against Worker A's gateway**: not run — the gateway side is being built in parallel to the same contract; ProductApi is verified against faithful `call()`-funnel fakes reproducing the real client's error flattening. Integration transcripts belong to the coordinator's validation pass.
