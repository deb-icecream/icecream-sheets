# Voice-Tolerant Command Palette — build plan (coordinator working notes)

Brief: BRIEF.md in this dir. Amendment 2026-10-21 16:20 PDT: (1) Pro-tier
gate; (2) built-in dictation STT = cheapest Gemini on Vertex.

## Verified seams (code-read 2026-10-21)
- Vocabulary: apps/web/src/features/functionList.ts ALL_FUNCTIONS — 565
  functions w/ name/category/signature/description, generated from the
  engine registry (exactly the evaluable set).
- Commands registry: apps/web/src/commands.ts (AppCommand) — UI actions;
  NO MCP path → NOT offered in the palette (brief rule). Exclusions are
  reported, not silently dropped.
- MCP tools (packages/mcp-server/src/server.ts): read_cells, write_cells,
  set_formulas, recalculate (+ create_pivot etc. — argument-rich agent
  tools, excluded from palette grammar, reported with reasons). All take
  optional string principal; fallback 'mcp-client'.
- Execution seam: apps/web/src/services/mcpToolClient.ts getLocalMcpCall
  (host) → in-process REAL MCP server (createServer). App.tsx already
  resolves it as artifactMcpCall for ArtifactHost/AppGeneration and sets
  it null in gateway mode ("no local MCP server in gateway mode (v1)") —
  the palette reuses the SAME seam and the SAME v1 boundary, stated
  honestly in UI + report (mirrors AppGeneration's existing message).
- App state: sheet + sel {row,col} (App.tsx:632-633); host.subscribe →
  setTick refresh (line 1475) — MCP writes refresh the grid via the host
  subscription. Dialog pattern: MenuSearchDialog (A11yDialog). Mount
  point: beside MenuSearchDialog (~8711). Keyboard handler ~7731: add
  Ctrl+Shift+P branch BEFORE the Ctrl+P branch (which doesn't exclude
  Shift). Command registry entry in the commands useMemo (~7799).
- Tier: product-layer CONTRACT — gateway stamps `tier` into our JWT at
  /auth/firebase + /auth/login. Web: GatewayClient stores the token in
  localStorage key 'icecream-sheets.gateway-token'; decode-only claim
  read mirrors decodeSub/principal(). No gateway session (standalone
  local/desktop) → tier system not engaged → palette enabled. Default →
  labeled Pro-only gate state (visible, not silent).
- STT: mirror packages/service/src/artifacts/llm.ts Vertex pattern
  (injected getAccessToken from the vault, generateContent URL).
  VERTEX_STT_MODEL = 'gemini-2.5-flash-lite' (cheapest Gemini; same
  model as VERTEX_DEFAULT_MODEL; pricing per user correction
  2026-10-21 17:08 PDT: $0.10/$0.40 per 1M is the TEXT rate — the
  AUDIO input rate is $0.30/1M) — override seam:
  VertexTranscribeOptions.model, parallel to VertexAiCodeGenOptions.
  Audio via inlineData part, temperature 0. Model confirmed kept as
  the dictation default by the user 2026-10-21 17:08 PDT; any future
  switch happens on MEASURED accuracy only (live validation transcribes
  the real mangled phrase set and reports resolution accuracy).
- Tests: apps/web vitest; component tests use react-dom/client + act
  with `// @vitest-environment jsdom` (AddonManagerDialog.test.tsx
  pattern). Service tests: artifactLlm.test.ts pattern (fake fetch).

## Files to build
- apps/web/src/services/voiceCommands.ts — matcher + grammar + catalog
  (pure): normalization, spoken numbers, cell-ref joining, alias layer
  (brief's mangles + user's: "some"→SUM…), similarity scoring
  (squashed-Levenshtein + token overlap + phonetic skeleton), command
  builders → {tool, args} for set_formulas / write_cells / read_cells /
  recalculate; skeleton prefill for any of the 565 functions.
- apps/web/src/services/voiceCommands.test.ts — matcher tests (≥3
  mangled incl. name mangles: "some if"→SUMIF, "vee look up"→VLOOKUP,
  "ex look up"→XLOOKUP; grammar: dictated ranges, criteria, write/read).
- apps/web/src/services/voiceTier.ts (+ test) — tier claim resolver.
- apps/web/src/components/VoiceCommandPalette.tsx — A11yDialog UI:
  input + mic (when transcribe prop supplied), match list + alternates,
  preview card (editable formula for formula kind), Run ONLY on explicit
  confirm action; Default-tier gate panel; null-mcp boundary note;
  read results rendered in-dialog.
- apps/web/src/components/VoiceCommandPalette.test.tsx — CONFIRM GATE
  test (mock McpCallFn: no call on type/match/preview; exactly one call
  with expected args after Run), tier gate test, boundary test.
- packages/service/src/artifacts/transcribe.ts (+ tests) — Vertex
  transcriber (model const + options seam), exported via artifacts
  barrel if one exists.
- Agent-service HTTP route POST /api/agent/transcribe (rides the
  existing gateway /api/agent proxy prefix — no gateway change) + web
  client glue — ONLY if the host's route table makes this a small,
  contained change; otherwise mic ships wired to the service function
  via the local agent runtime path and the gap is reported plainly.
- App.tsx wiring: state, Ctrl+Shift+P, commands entry, header button
  (next to the agent chat toggle, with a Pro badge for Default),
  mount with props {sheet, selection, tier, mcpCall: artifactMcpCall,
  ready: workbookLoaded, transcribe, onClose}.

## Offered commands (each = exactly one real MCP call)
1. Insert formula — any of 565 functions at the selected cell
   (set_formulas). Dictated-range grammar for aggregate + *IF families;
   INDEX/MATCH combo alias; skeleton+edit for the rest.
2. Write value — "set B3 to 42" (write_cells).
3. Read cells — "read B2 to B5" (read_cells; results shown in palette).
4. Recalculate — (recalculate).

## Excluded (reported with reasons)
- All AppCommand UI actions (open dialogs, save, print, …): no MCP tool
  path exists; brief forbids offering them.
- create_pivot / analyze_data / execute_code / open_data_source /
  appbuilder_* / report_*: argument-rich agent tools, not expressible
  in the palette's confirm-one-call grammar; they remain available via
  the agent chat and their own dialogs.

## Live transcript (user requirement, 2026-10-21 17:08 PDT)

While the user dictates, the spoken words must appear as written text
in real time so they can SEE what was heard and correct it ("no,
that's not what I said — I said X") before anything executes. Design:
rolling transcription over the SAME Vertex route and model — while
recording, the client re-sends the full audio-so-far to
POST /api/agent/transcribe every ~2s; each response updates (a) a
visually distinct live-transcript panel and (b) the command input
itself — UNLESS the user has manually edited the input during this
dictation (their correction wins; later polls then update only the
panel). On stop, one final full-clip transcription lands (again
respecting a manual correction). The corrected text drives the normal
match → preview → explicit Run confirm; nothing executes from the
transcript alone. A true streaming Live-API route was NOT used: it
requires a different (Live-only) model, and the user ruled the STT
default stays gemini-2.5-flash-lite. Cost bound: dictation capped at
60s; each poll re-transcribes ≤60s of audio at $0.30/1M audio tokens
(~32 tok/s → ≤ ~2k tokens/poll worst case).

## Validation sequence
1. vitest: new suites + related (commands, MenuSearch-adjacent, service
   artifactLlm/transcribe) + tsc --noEmit (apps/web + service).
2. Live local-mode proof: build dist to a PRIVATE outDir (never touch
   the shared dist while Phase 2 tours run), serve on own port, Chrome
   headless (playwright-core): type "some if b two to b twenty greater
   than ten" → preview =SUMIF(B2:B20,">10") at the selected cell →
   confirm → screenshot sheet changed + tool transcript; a write-value
   case; screenshots before/after.
3. Live tier proof: alternate-port stack (18100/18101, scratch
   SESSION_DATA_DIR, signed bake to private outDir): /auth/login
   Default user → palette shows the Pro gate (screenshot). Pro state:
   component test (tier='pro' executes) + local-mode live proof
   (standalone = tier not engaged) — stated as such in the report.
4. STT proof: endpoint exercised with a generated speech WAV if a TTS
   tool exists on the VM; otherwise unit-level + route smoke, live
   Vertex call reported NOT RUN with the reason (credentials are the
   agent-features coordinator's wiring task).
```
