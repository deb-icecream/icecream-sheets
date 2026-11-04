# Voice-Tolerant Command Palette — BRIEF (Idea idea_5ee42102fb714414a033de5304a372cb)

User accepted 2026-10-21. Build inside the icecream-sheets product
codebase (apps/web), shipping as part of the spreadsheet UI.

## Outcome
A command palette in the spreadsheet UI that treats mangled dictated
text as a normal input mode: it fuzzy-matches the text against the
app's commands and formula/function names, SHOWS the interpreted match
for confirmation, and executes ONLY after the user confirms — through
MCP tools, never a side-channel write.

## Requirements
- Palette reachable from the spreadsheet UI (button + keyboard
  shortcut), with a text field that accepts typed or dictated input.
- Matching: normalization (case/spacing/punctuation), token and
  phonetic-style similarity, plus an alias layer seeded from REAL
  mangle patterns from the user's dictation history, e.g.:
  "some if" → SUMIF, "vee look up" → VLOOKUP, "ex look up" → XLOOKUP,
  "count if" → COUNTIF, "if error" → IFERROR, "text join" → TEXTJOIN,
  "some product" → SUMPRODUCT, "index match" → INDEX/MATCH. Show the
  best match (and alternates when close) as a readable command preview
  (what it will do, and where — e.g., target cell/formula).
- CONFIRM GATE (hard rule): nothing executes before an explicit user
  confirmation of the shown match. A test must prove no tool call
  happens pre-confirmation.
- EXECUTION PATH (hard rule): confirmed commands execute through the
  product's MCP tool layer (the same tool path the agent uses — see
  packages/mcp-server and the service agent backends; apps/web already
  has agent service clients). NO direct engine side-channel writes.
  Commands that have no real MCP execution path are NOT offered — no
  stubs. List any excluded commands in your report with the reason.
- Scope: the palette only. Do not change chat behavior or formula
  evaluation.

## Validation
- Unit tests for the matcher, including at least three genuinely
  mangled inputs and at least one NAME mangle (a mangled function
  name), drawn from the patterns above.
- Component test for the confirm gate.
- Live proof in the local stack (real browser): dictate/type a mangled
  command, confirm, show the sheet changed via the tool path
  (transcript + before/after screenshots).
- Related suites green; standard file open/save flows untouched.

## Coordination
Other coordinators are active (Phase 2 validation, product layer,
agent features). One browser process per output dir; never rebuild
apps/web/dist while another coordinator is mid-tour — check their
report dirs and sequence. NO git push — the parent pushes and
byte-verifies. Final report: what was built, the offered-command list
with its MCP mapping, excluded commands + reasons, test counts,
evidence paths, and anything NOT done stated plainly.
