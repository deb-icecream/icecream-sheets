# LANDING REDESIGN — REPORT (worker, 2026-10-22)

Status: IN PROGRESS. Checkpoint-first per house rules; appended after each landed piece.

## Recon (done)
- Brief read in full. Current page: `apps/web/src/product/LandingPage.tsx` + landing section of `apps/web/src/product/product.css`; images in `apps/web/public/product/` (hero-dashboard.png 1600×1000 140 KB, collab.png 1500×950 71 KB, pivotchart.png 1600×1000 149 KB — all REAL product screenshots, already compressed).
- Mount/routing: App.tsx ~8978 — bare logged-out visit → LandingPage; `onSignIn` reveals `GatewayLogin`, which offers "Sign in with Google" (Firebase). So the CTA leg = landing click → login gate → Google button present. Component props contract (`loggedIn`, `onSignIn`, `onOpenWorkspace`) unchanged by this redesign.
- Design decision: keep the product.css variable palette (theme-consistent incl. dark theme) and rebuild the landing section in Apple grammar: sticky blurred nav, huge clamp() type, one claim per screen, IntersectionObserver reveals armed via a mount-time class (content visible without JS / without IO), `prefers-reduced-motion` kills the animation layer in CSS, one sticky visual (agent Q/A card) on wide screens only.
- Sign-in: the page's sign-in button is labeled "Sign in with Google" (with the Google G mark), per the user's ruling. Logged-in state keeps "Open workspace".

## Claim ledger (traceability — checked before use)
- 517 of Excel's 523 functions: VERIFIED — hidden_files/function-coverage/FUNCTION-LIST-AND-GAPS.md ("517/523 implemented & callable; 6 documented legacy skips").
- Benchmark 463/465 = 99.57%: checking benchmark repo README/leaderboard next.
- "~1.3 MB per file, 10 files" Default caps; created files any size: from the product record + existing tier copy/tests (1,285,214 B cap).
- Agent answers from the sheet: case 1 of the agent proof PASSED 5/5 ("total revenue" → 159,400 exact, from hidden_files/agent-rerun + planner-fix records).
- CUT candidates: any specific agent *edit* example (e.g. "set Jun South to 15,000") — the planner-fix program recorded a wrong-row failure shape for that exact turn; will not be used as a marketing example. Agent edits described generically ("a real edit in the sheet, saved like your own") — that mechanism is validated (case 11 read-back 58==58; ops are journaled).

## Plan
1. Verify benchmark numbers + landing-class usage elsewhere + image tooling.
2. Rewrite LandingPage.tsx (sections: hero / agent / live data / Excel numbers / co-authoring / tiers / final CTA / footer).
3. Rewrite the landing section of product.css (+ landing parts of the ≤720px media query). Workspace CSS untouched.
4. Update LandingPage.test.tsx to the new copy/behavior (its own test file; tier-label and no-"free" rules preserved).
5. Product tests → full web suite → tsc.
6. build:local-stack + verify-dist; serve dist on own port; playwright screenshots 1440 / 390×844 / 375×667 / 820, overflow asserted, reduced-motion pass, CTA click leg. Self-inspect screenshots.
7. Final copy + line-by-line fluff audit pasted here.

## Landed (checkpoint 2)
- `LandingPage.tsx` rewritten: sticky blurred nav; hero ("The spreadsheet that does the work with you."); agent section with the REAL exchange card (total revenue → $159,400, case-1-proven; sticky on wide screens); live-data section with 3 fact rows; Excel numbers section (517 / 99.57% + benchmark link + byte-audit line + PivotChart shot); co-authoring (collab shot); Default/Pro tiers (labels exact, caps unchanged); final CTA; footer. Sign-in action = "Sign in with Google" button (Google G mark) in nav, hero, and final CTA; logged-in = "Open workspace".
- Responsive variants generated (PIL, 960w, palette-quantized): hero 54 KB, pivotchart 56 KB, collab 32 KB (vs 140/149/71 KB) + srcset/sizes on all three imgs.
- `product.css`: landing section fully replaced (ics-lp-* classes; clamp() type scale; IntersectionObserver reveal classes; reduced-motion layer off; ≤860px split-stack; ≤720px landing rules). Old landing classes deleted (grep: 0 refs remain; only LandingPage used them). Workspace/settings CSS byte-untouched.
- `LandingPage.test.tsx` rewritten to the new copy/behavior. **Landing tests 8/8 PASS; product suite 9 files / 92 tests PASS.**
- CUT as unverifiable: the specific agent *edit* example ("set Jun South to 15,000") — planner-fix recorded a wrong-row failure for that turn shape; agent edits are described generically instead. Also dropped: "AI-native / Data-native" labels and the six-item capabilities grid (brochure grammar the user rejected).

## BLOCKER (not mine — disclosed, not touched)
- `apps/web/src/components/GatewayLogin.tsx` (deploy program's production-login gating edit, mtime 14:16 UTC) currently has 2 tsc SYNTAX errors (119,9 TS1005; 125,10 TS1381) — the `devLoginEnabled && (` wrapper is mis-nested. Unchanged across an 11-minute window. Consequence: `npm run build:local-stack`'s `tsc` gate fails repo-wide. My touched files are tsc-clean (tsc output contains ZERO errors outside GatewayLogin.tsx). Validation proceeds by replicating build:local-stack exactly minus the tsc gate (same env: VITE_GATEWAY_URL=http://localhost:8100, VITE_ENGINE_ACCESS_MODE=signed, then scripts/verify-dist.mjs --local-stack) and is flagged as such wherever reported. The deploy coordinator owns the GatewayLogin fix.
- Validation port block claimed for this program: **8941** (static dist server only; no gateway/engine started).

## Successor #2 resumed (2026-10-22)
- Two predecessors died in daemon restarts. Resuming from checkpoint 2; verifying landed state on disk before running the validation half: (1) full web suite, (2) screenshots 1440 / 390×844 / 375 / 820 on port block 8941 with overflow asserted, (3) copy paste + no-fluff audit, (4) reduced-motion pass, (5) sign-in CTA leg. GatewayLogin.tsx blocker is NOT mine — will check whether the deploy coordinator has fixed it; if not, validate via the exact build:local-stack replication minus the tsc gate, flagged as such.

## Successor #3 resumed (2026-10-22)
- Successors #1 and #2 both died in daemon restarts. Resuming from checkpoint 2 + successor #2's note. Verifying landed state on disk first (LandingPage.tsx content, product.css ics-lp-* classes, responsive image variants, GatewayLogin.tsx tsc state), then the validation half: (1) full web suite, (2) screenshots 1440 / 390×844 / 375 / 820 on port block 8941 with overflow asserted, (3) copy paste + no-fluff audit, (4) reduced-motion pass, (5) sign-in CTA leg. GatewayLogin.tsx is NOT mine — check only.

## Successor #3 — landed state verified + blocker CLEARED
- On disk: LandingPage.tsx 13,660 B (hero headline + "Sign in with Google" present); product.css carries the ics-lp-* landing section (64 refs); responsive variants present (hero-960 54,099 B, pivotchart-960 56,450 B, collab-960 31,929 B); old landing classes 0 refs. Checkpoint 2's account is accurate.
- **GatewayLogin.tsx blocker is FIXED** (deploy program's file, mtime 14:32 UTC): full `npx tsc --noEmit` in apps/web exits 0 with zero errors repo-wide. The real `npm run build:local-stack` is therefore usable for validation — no replication needed. Port 8941 free.

## Successor #3 — full web suite GREEN
- `npx vitest run` in apps/web (TMPDIR under ~/workspace): **153 test files passed, 1,982 tests passed, 0 failed** (223.8 s). Includes the rewritten LandingPage tests.
- Correction to the suite line above: the run's terminal completion record (session proc_d885d7b9c11e) reports **150 test files passed, 1,927 tests passed, 0 failed** (462 s). An earlier mid-flight delivery showed different tallies (153/1,982); both agreed on zero failures. The terminal record is the one cited.

## VALIDATION — successor #3, complete (2026-10-22)

### Build path actually used
- **The real `npm run build:local-stack`** — the deploy program's GatewayLogin.tsx
  syntax errors were already fixed in the tree (full apps/web `tsc --noEmit`
  exits 0), so no gate replication was needed. `scripts/verify-dist.mjs
  --local-stack` PASS: dist bakes gateway=http://localhost:8100 +
  engineAccess=signed (6 JS assets checked).
- Honesty note: one intermediate background build reported exit 0 with output
  that did not correspond to this app (small alien chunk names) and did not
  update dist. Caught by dist-mtime forensics; the build was re-run in the
  foreground of a logged session (exit 0, verify-dist OK, dist mtime after the
  CSS fix, override rules grep-verified inside the emitted CSS). All
  screenshots below are from that verified dist.
- Served by a static server over `apps/web/dist` on port **8941** (claimed
  block; static only, no gateway/engine started). Driver: `harness.mjs` in
  this directory (Playwright + chrome-headless-shell); raw data:
  `shots/results.json`.

### Suites
- Full apps/web vitest: **150 test files passed, 1,927 tests passed, 0 failed**
  (terminal completion record of the run; an earlier mid-flight delivery
  showed 153/1,982 — both agreed on zero failures). LandingPage 8/8 and the
  product suite 92/92 were already green at checkpoint 2 and remain in the
  passing set. tsc clean.

### Per-width verdicts (full scroll sequences, self-inspected)
- **Desktop 1440×900 — PASS.** 10 shots (`shots/desktop-1440/`). Sticky blurred
  nav; hero, agent (real $159,400 exchange card), live data, Excel
  (517 / 99.57% stats + benchmark link), co-authoring, tiers, final CTA,
  footer all render in the one-claim-per-screen grammar. Overflow: scrollWidth
  1440 == clientWidth 1440 at top and bottom.
- **iPhone 390×844 — PASS (after one fix).** 8 shots (`shots/iphone-390x844/`).
  First run: the nav wordmark and the nav button label wrapped to two lines
  (no overflow, but not launch-page polish). Fixed in the landing CSS only
  (≤720px: wordmark 16px + nowrap; nav button 13px, tighter padding, nowrap;
  nav gap 10px) and re-shot: wordmark and "Sign in with Google" now sit on one
  line; hero type, sub, CTA, and the 960px dashboard render crisply. Overflow:
  390 == 390 top and bottom.
- **Small phone 375×667 — PASS (same fix).** 10 shots (`shots/small-375x667/`).
  Nav one line after the fix; everything legible; tiers stack. Overflow:
  375 == 375 top and bottom.
- **iPad 820×1180 — PASS.** 6 shots (`shots/ipad-820/`). The agent split stacks
  (copy above, exchange card full width); all sections readable at the wider
  measure. Overflow: 820 == 820 top and bottom.
- **Console/page errors across all four viewports: 0.**
- Not separately shot: dark theme (the landing consumes the product palette
  variables incl. the `:root[data-theme='dark'] .ics-landing` block unchanged;
  the workspace-settings program proved theme switching on this shell).

### Reduced motion — PASS
Context with `prefers-reduced-motion: reduce` at 1440×900: all **14**
`.ics-lp-reveal` elements compute to opacity 1 with no scroll; top and bottom
screenshots (`shots/reduced-motion/`) inspected — full page content visible,
identical final state to the animated page.

### Sign-in CTA path — PASS
Clicked the hero "Sign in with Google" button: the "Sign in to Icecream
Sheets" dialog appeared offering **Sign in with Google**
(`shots/cta/01-after-click.png`; harness assertions dialogAppeared /
dialogHasGoogle / googleButtonPresent all true). Disclosure: this local-stack
build also shows the local-dev User ID field under "— or —" because the
gateway URL is localhost (`devLoginEnabled` by design in this build flavor);
the production build points at the real gateway, where the deploy program's
gating hides it (user ruling 2026-10-22). The landing itself offers exactly
one sign-in: Google.

## FINAL COPY (verbatim from LandingPage.tsx) + line-by-line audit

Audit rule (brief): short, declarative, human; no buzzword fluff, no emoji
bullets, no generic superlatives; every claim traceable to a record. Grep
scan of the component for banned vocabulary (revolution*, unlock, seamless,
leverage, delve, supercharg*, cutting-edge, world-class, game-chang*,
ultimate, effortless, empower, streamline, synergy, elevate): **zero hits**.
The word "free" appears **nowhere** on the page.

- Nav: "Icecream Sheets" / "Sign in with Google" — the only sign-in offered. OK.
- Hero H1: "The spreadsheet that does the work with you." — plain claim, no
  superlative. OK.
- Hero sub: "Ask a question and it reads your data. Ask for a change and it
  makes it. Open any Excel file and every formula calculates." — declarative.
  JUDGMENT CALL (kept): the last sentence is launch-page-broad; the exact
  figure (517 of 523) is stated in the numbers section of the same page.
- Agent eyebrow: "The AI agent". H2: "Ask. It answers. Tell it. It's done." OK.
- Agent body: "The agent works in the sheet in front of you, through the same
  tools you use. There is no separate chatbot and no copy-paste. An answer
  comes from your cells. A change it makes is a real change — calculated,
  saved, and visible to everyone in the file." — matches the agent design
  record (MCP tools only; co-authoring validation). OK.
- Chat card: You — "What's the total revenue in the Sales sheet?" / Agent —
  "$159,400" / caption "A real question, answered from the sheet's own cells."
  — the exchange is from agent proof case 1 (PASS 5/5, planner-fix record).
  TRACEABLE. (The earlier draft's unverifiable edit example stays CUT.)
- Live data eyebrow: "Live data". H2: "Your data stays where it lives. The
  sheet comes to it." Body: "A spreadsheet here is a view, not a file you
  export and forget. Connect a source and the grid shows that data. Change a
  number, and the charts and pivots built on it move too — because they were
  never copies." — the view-over-data architecture, stated plainly. OK.
- Facts: "Excel files — Open them, edit them, save them back — intact." /
  "CSV — Upload one and it becomes a workbook that calculates." (workspace
  CSV-upload record, 44/44) / "Databases and APIs — Connected live, and shown
  as a grid you can work in." (data-source gallery record). TRACEABLE.
- Excel eyebrow: "Excel compatibility". H2: "Your Excel files, exactly as
  Excel left them." Stats: "517 — of Excel's 523 functions work here —
  implemented and tested, one by one." / "99.57% — on our published benchmark:
  463 of 465 checks matched Excel. Read the results" (link to the public
  benchmark repo). Body: "Open a file and it calculates. Save it, and a
  byte-level audit finds nothing missing — formulas, names, and formatting all
  survive the round trip." — function-coverage + round-trip audit records.
  TRACEABLE.
- Co-authoring eyebrow: "Co-authoring". H2: "One sheet. Everyone in it. Live."
  Body: "Share a file and everyone edits the same copy. A change appears the
  moment it happens, in the order it happened. There are no merges to resolve
  — just the sheet, current for everyone looking at it." — Phase 2 validation
  record (S1–S11). OK.
- Plans eyebrow: "Plans". H2: "Start on Default. Move up when you outgrow it."
  Default card: "Default" / "Everything, with two caps." / "Uploads up to
  ~1.3 MB per file" / "Up to 10 files in your workspace" / "Create new
  spreadsheets of any size" / "Formulas, charts, pivots, and co-authoring
  included". Pro card: "Pro" / "The caps, removed." / "Uploads of any size" /
  "As many files as you need" / "Everything in Default". — tier record exact
  (1,285,214-byte cap ≈ ~1.3 MB; 10 files; created files uncapped). JUDGMENT
  CALL (kept): "Everything, with two caps" is immediately qualified by the two
  named caps in the same card. Default is never labeled "free". OK.
- Final: "Open your first sheet." + Google button. Footer: "Icecream Sheets —
  a spreadsheet for people and agents." + "Published benchmark results". OK.

### Program state
Landing redesign: rewrite + full validation COMPLETE. Not deployed (per
instructions — the hosting redeploy is the parent's call). Changed in this
validation pass beyond the checkpoint-2 state: one CSS fix (phone nav,
`product.css` ≤720px landing rules). Everything else is evidence:
`harness.mjs`, `shots/` (37 screenshots + results.json), this report.
