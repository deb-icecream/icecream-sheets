# Voice-Tolerant Command Palette — final report

Coordinator report for Idea `idea_5ee42102fb714414a033de5304a372cb`
(accepted 2026-10-21), including the two binding amendments of
2026-10-21 16:20 PDT (Pro-tier gate; cheapest-Gemini Vertex STT) and
the two decisions of 17:08 PDT (flash-lite kept; LIVE TRANSCRIPT
requirement). **No git push** (parent pushes and byte-verifies).

## What was built

**Palette UI** — `apps/web/src/components/VoiceCommandPalette.tsx`
(A11yDialog): 🎙️ Voice FAB + Ctrl+Shift+P + a "Voice command
palette…" entry in the command registry (View category). Type or
dictate a command → the interpreted match is shown as a preview card
(match name + score, action label with target cell, editable formula,
alternate-match chips) → **nothing executes until the user clicks Run
(or Ctrl+Enter)**. Read results render in-dialog.

**Matcher** — `apps/web/src/services/voiceCommands.ts` (pure):
normalization (spoken numbers, punctuation, split-ref joining "b 2"→
B2 with a grammar-word guard), an alias layer validated against the
real 565-function catalog (`features/functionList.ts` ALL_FUNCTIONS),
and generic span scoring (squashed-Levenshtein + phonetic skeleton +
prefix; longer dictated phrases win near-ties). Grammar: dictated
ranges for aggregates, criteria grammar for SUMIF/AVERAGEIF/COUNTIF
(incl. optional sum-range), INDEX/MATCH combo, skeleton + user-edit
prefill for every other catalog function.

**Dictation with LIVE TRANSCRIPT** (17:08 requirement): mic button
(gateway sessions) records via MediaRecorder; while recording, the
audio-so-far is re-transcribed every ~2 s over the same Vertex route
and the words appear as text in real time — in a labeled
"● LISTENING — LIVE TRANSCRIPT" panel and mirrored into the command
input. **Correction rule:** if the user edits the input mid-dictation,
their text wins — later polls keep updating the live panel but never
overwrite the correction; stopping runs one final full-clip pass
under the same rule. Dictation caps at 60 s. Nothing executes from a
transcript; the (corrected) text still needs the explicit Run.

**STT backend** — `packages/service/src/artifacts/transcribe.ts`
(`VertexTranscriber`, mirrors the artifacts LLM module) exposed via
`POST /api/agent/transcribe` on the agent service (rides the existing
gateway `/api/agent` proxy; 4 MB body cap, 413/400/503/502 mapping).
Credentials: `packages/gateway/src/services/vertexToken.ts` (SA-key
JWT exchange or metadata server, fail-soft; the runtime SA in
production).

**STT model + config seam (user-confirmed 17:08):**
`VERTEX_STT_MODEL = 'gemini-2.5-flash-lite'` in
`packages/service/src/artifacts/transcribe.ts` — the cheapest Gemini,
same model as `VERTEX_DEFAULT_MODEL`. Override seam:
`VertexTranscriberOptions.model` (host wires `VERTEX_STT_MODEL` env).
Pricing correction recorded in PLAN.md: $0.10/$0.40 per 1M is the
TEXT rate; the AUDIO input rate is $0.30/1M. A streaming Live-API
route was deliberately NOT used — it requires a Live-only model and
the user ruled the default stays flash-lite; rolling transcription
delivers the live transcript on the ruled model.

**Tier gate** — `apps/web/src/services/voiceTier.ts`: decode-only read
of the tier stamped into our gateway JWT at login. 'pro' → enabled;
'default' → labeled Pro-only gate panel (no input, no execution path)
and the FAB carries a "· Pro" marker; no gateway session →
'standalone' (tier system not engaged, palette enabled); unreadable
token → fail closed to 'default'. **Live-proof catch:** the real
claim is nested — `{sub, attrs:{tier}}` — a first version reading a
top-level `tier` claim gated a Pro user out in the gateway proof;
fixed to read `attrs.tier` (top-level also honored), with the real
wire shape pinned in unit tests.

## Offered commands — each exactly one MCP call (principal 'web-user')

| Palette command | MCP tool |
|---|---|
| Insert formula (any of the 565 catalog functions at the selected cell) | `set_formulas` |
| Write value ("set C3 to 42"; a "="-prefixed value reroutes to formula) | `write_cells` |
| Read cells ("read B2 to B5") | `read_cells` |
| Recalculate | `recalculate` |

Execution reuses the product's existing client MCP seam
(`mcpToolClient.getLocalMcpCall` → the in-process real MCP server;
App.tsx `artifactMcpCall`, the same caller generated apps use).

## Excluded — with reasons (per the brief's no-stub rule)

- **All AppCommand UI actions** (open dialogs, save, print, …): no MCP
  tool path exists; the brief forbids offering commands without one.
- **Argument-rich MCP tools** (`create_pivot`, `analyze_data`,
  `execute_code`, `open_data_source`, `appbuilder_*`, `report_*`): not
  expressible in the palette's one-call confirm grammar; they remain
  available via the agent chat and their own dialogs.

## Boundaries stated plainly

- **Hosted (gateway) sessions: execution is v1-unavailable** — the
  product exposes no client MCP caller there today (same boundary as
  generated apps); Phase 2 writes must flow through the collab op
  queue, so no side channel was improvised. The palette matches,
  previews, transcribes, and says why Run is disabled. Local/desktop
  engine modes execute fully (proven live).
- **Full STT accuracy set NOT measured live:** the sampling run's
  second phrase hit a Vertex AI **429 (resource exhausted)**; sampling
  stopped immediately (rate-limit discipline — no retries). See
  measured numbers below; `stt-samples.mjs` + `score-accuracy.mjs`
  rerun the full set when quota allows.
- User's own voice recordings are not on this VM; accuracy audio was
  synthesized (Gemini TTS) from the user's real dictated phrases.

## Tests (all passing)

- Matcher `voiceCommands.test.ts`: **26** (all brief mangles: "some
  if"→SUMIF, "vee look up"→VLOOKUP, "ex look up"→XLOOKUP, "count
  if"→COUNTIF, "if error"→IFERROR, "text join"→TEXTJOIN, "some
  product"→SUMPRODUCT, "index match"→INDEX+MATCH; range/criteria
  grammar; write/read/recalc; gibberish→no match).
- Tier `voiceTier.test.ts`: **7** (incl. the real `attrs.tier` shape,
  both tiers; fail-closed cases).
- Component `VoiceCommandPalette.test.tsx`: **8** — incl. the
  CONFIRM-GATE test (no tool call while typing/previewing; exactly one
  `set_formulas` call with the shown args after Run), read rendering,
  Default gate, standalone, boundary, and two LIVE-TRANSCRIPT tests
  (live mirroring never executes; mid-dictation correction wins over
  later transcripts and the final pass; the corrected text is what Run
  executes).
- Service `artifactTranscribe.test.ts`: **7** (with artifactLlm: 22).
- Gateway `agentTranscribe.test.ts` 4 + `vertexToken.test.ts` 2;
  neighbors re-run green (gateway batch 23; web related batch 65).
- Typecheck: service + gateway clean; web clean for every file this
  build touched. One remaining web tsc error is NOT from this build:
  `src/features/functions.ts(20,10)` TS2367 (a version-constant
  comparison exposed by the function-coverage track's regenerated
  `functionList.ts`, git-modified by that track; functions.ts itself
  untouched since 2026-10-19).

## Live evidence (`hidden_files/idea-voice-palette/shots/`)

- **Execution (local mode)** — `proof-local.mjs`, all steps PASS:
  seeded B2:B4=5/15/25, selected D2, typed "some if b two to b twenty
  greater than ten" → SUMIF preview `=SUMIF(B2:B20, ">10")` → Run →
  D2=40; "set c3 to 42" → C3=42. `proof-local.json`,
  `local-before.png`, `local-palette-preview.png`, `local-after.png`.
- **Gateway mode** — `proof-gateway.mjs` on an isolated stack
  (gateway :18100 / engine :18101 / agent :18107, scratch data),
  all steps PASS: Default login (JWT tier=default) → FAB "🎙️ Voice ·
  Pro" → gate screenshot (`gw-default-gate.png`); Pro login (promoted
  via the operator `set-tier` tool, fresh JWT tier=pro) → palette
  ungated → dictation with the STT route intercepted at the browser
  edge returning a wrong hearing: live transcript filled in while
  recording (`gw-live-transcript.png` — panel + input + SUMPRODUCT
  preview, still listening), user corrected the text → later
  transcripts and the final pass did not overwrite it → match flipped
  to SUMIF `=SUMIF(B2
...[truncated 1231 chars]