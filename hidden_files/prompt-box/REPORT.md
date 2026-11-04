# Prompt Box Redesign — Checkpoint Record

**Task:** Redesign the AI agent chat prompt box (user request, 2026-10-22 ~17:02 PDT).
**Port block:** 9100-9109 (this worker only).
**Repo:** ~/workspace/icecream-sheets. TMPDIR under ~/workspace. progress.md untouched. No push (parent pushes).
**GitHub issue:** **#25** — https://github.com/is-cream/icecream-sheets/issues/25 ("Agent prompt box: multiline, auto-growing (min/max height), Gemini-style look and feel").

## User spec
1. Multiline textarea (real textarea, not single-line input).
2. Auto-grow with content up to a MAX height; beyond max, internal scroll only; shrink back to min height after send.
3. MIN height noticeably larger than the current too-small size.
4. Gemini prompt-box look: one rounded container (~24-28px radius), subtle border, surface color distinct from panel bg; borderless transparent textarea inside; action buttons inside the container along the bottom row, send at bottom-right; comfortable padding; clear placeholder.

## Constraints
- Existing CSS design tokens only, no hardcoded colors; correct in light AND dark themes.
- Preserve: send flow (Enter sends, Shift+Enter newline), 2,000-char cap behavior if client-enforced, pending-ask states, disabled-while-busy, composer always renders when panel open (issue #2 acceptance).
- Panel is docked right + resizable; box must fit all panel widths, no stray scrollbars outside the textarea's internal one.
- Another worker edits other apps/web areas concurrently (ribbon) — re-read shared files (esp. index.css) immediately before editing; keep edits scoped to the composer.

## State log
- [started] Checkpoint created. Locating current composer code.
- [code read] Composer found: `apps/web/src/components/AgentChat.tsx` lines 681-699 — `.agent-input-row` flex row containing a single-line `<input>` + a Send `<button>` beside it. CSS: `apps/web/src/index.css` lines 817-843 (input: padding 6px 8px, radius 8px → ~30px tall; row total ~46px). That ~30px input is the "too small" box.
- [behavior read] `send()` (AgentChat.tsx:386): trims, no-ops when empty/busy, clears draft, pushes user msg, routes. Current keys: Enter sends, Escape closes panel. NO client-side 2,000-char cap exists in AgentChat/remoteAgent (grep-verified) — send passes full text; nothing to preserve there beyond not truncating.
- [tokens] Panel bg = var(--bg); composer surface choice = var(--panel) (distinct in both themes: light #fff on #f4f6f8; dark #1e293b on #0f172a). Border var(--line); focus-within var(--accent); placeholder var(--muted); Send pill var(--accent-soft). No hardcoded colors.

## Design values chosen
- Container `.agent-composer`: radius **26px**, border 1px solid var(--line), bg var(--panel), padding 10px 12px 8px 16px; actions row inside at bottom, Send pill at bottom-right.
- Textarea: borderless/transparent, resize none, font-size 14px, line-height 1.5 (21px/line).
- **Min height: 46px** (textarea, ~2 lines) — vs current ~30px single-line input.
- **Max height: 168px** (textarea, 8 lines); beyond → internal `overflow-y: auto`, box stops growing.
- Auto-grow via ref + layout effect on draft (and panel width); send clears draft → box returns to min height automatically.
- Keys: Enter sends (not during IME composition), Shift+Enter newline, Escape closes panel (preserved).

## Implementation (landed)
**Issue #25.** Two files changed, both scoped to the composer:
- `apps/web/src/components/AgentChat.tsx`:
  - `useLayoutEffect` import added; `composerRef` + auto-grow layout effect (deps: `draft`, `panelWidth`) — sets `height:auto` then `scrollHeight` px.
  - Composer markup: `.agent-composer` container > `textarea` (rows=2) + `.agent-composer-actions` (Send button at bottom-right).
  - Keys: Enter sends unless Shift held or IME composing (new guard); Shift+Enter = newline; Escape closes panel (preserved).
- `apps/web/src/index.css`: replaced `.agent-input-row input/button` rules with `.agent-composer*` rules — radius 26px, bg var(--panel), border var(--line), focus-within border var(--accent); textarea borderless/transparent, 14px/1.5, **min-height 46px, max-height 168px**, internal overflow-y auto; Send = pill (var(--accent-soft), radius 999px). Tokens only, no hardcoded colors. (Old `.agent-input-row input` selectors had no other consumers — grep-verified, incl. no shipped tests.)

## Validation so far
- `npx tsc --noEmit` in apps/web: **exit 0** (the transient `engineTransport.test.ts` error seen mid-run was the follow-up worker's in-flight edit; clean on re-run).
- Stack on ports 9100/9101/9102/9103 (gateway/engine/web/service; byte-rewritten dist): all /health 200.
- **Before state (screenshot `shots/before-light-panel.png`):** row 339x46, input 29px tall, tag INPUT — the "too small" box, confirmed.
- **After geometry (measured, full tour `results-after.json`):**
  - (a) empty: composer 99px tall, textarea 46px (=min), radius 26px — light AND dark. Dark tokens: composer bg rgb(30,41,59)=--panel vs panel bg rgb(15,23,42)=--bg — distinct. Send inside container bottom-right (11px right gap). No horizontal overflow anywhere (scrollW==clientW).
  - (b) 4 lines via fill: textarea 88px (grew), scrollHeight==clientHeight → NO internal scrollbar; composer 141px.
  - (c) 40 lines: textarea capped at **168px = max**, scrollHeight 1684 → internal scroll only; composer 221px; panel layout intact.
  - (d) first attempt: send cleared draft → box back to min (46px) immediately; reply leg failed on missing agent service (502) — stack fixed (service on 9103 + SERVICE_COMBINED=on).

## BLOCKER (environment/tree, not the composer)
Subsequent runs hit failures OUTSIDE the composer path:
1. Stale 409 wedge on /api/engine/open ("engine already owns a different file") after rapid stack restarts — sibling workers' F-3/F-4 territory (their cross-finding: stale session wedges opens past the 10-min idle rule). The F-4 blocking overlay rendered correctly per its design.
2. Then React error #185 (Maximum update depth exceeded) on the LANDING page with a body-blank app — in a dist that worked minutes earlier (frozen bytes; fresh browser context). Prime suspect: a sibling worker's just-landed App.tsx (00:02 UTC) change racing something stateful (localStorage panel width? backend responses?). AgentChat is NOT mounted at landing, so the composer cannot be the loop — but a fresh non-minified diagnostic dist (ports 9100 block: web on 9104) is building to get the real component stack and confirm.

Next: confirm the loop's component via diag dist; if it's sibling code, re-run leg (d) on the frozen good dist against a fully clean stack (kill ALL strays via pkill first — found 3 orphaned backend generations from rapid restarts).

## Root cause of the #185 (resolved)
The #185 was NOT in my code: the diag dist (same tree, non-minified) boots fine, and the "looping" 9102 dist had worked at 17:10 and looped at 17:13 with IDENTICAL bytes served. Cause: start_stack.py re-copies the SHARED `apps/web/dist` on every restart, and the concurrent ribbon worker rebuilt `apps/web/dist` between my stack restarts with its own mid-edit tree (a broken intermediate). Lesson: rebuild my own dist immediately before each validation run, and treat any sudden boot failure on a reused dist as dist contamination first.

## Final validation (dist rebuilt from current tree@~17:28 PDT + my changes; clean stack, ports 9100-9103)
- `npx tsc --noEmit` apps/web: **exit 0** (final run).
- Related tests: `src/services/remoteAgent.test.ts` **8/8 PASS**. (No shipped AgentChat component tests exist; no test references the old `.agent-input-row input` selector — grep-verified.)
- Full tour re-run on final dist (results-after.json + results-d.json):
  - **(a) empty, light + dark:** composer 99px tall, textarea 46px (=min, 26px radius), placeholder clear, Send pill bottom-right inside the container. Dark: composer rgb(30,41,59) vs panel rgb(15,23,42) — distinct, readable. No horizontal overflow anywhere (scrollW==clientW on chat and composer). Shots: after-a-empty-light-panel.png, after-a-empty-dark-panel.png — self-inspected PASS.
  - **(b) 4 lines:** textarea 88px (auto-grew), scrollHeight==clientHeight → no internal scrollbar; composer 141px. Shot after-b-grown-panel.png — PASS.
  - **(c) 40 lines:** textarea capped at 168px (=max), scrollHeight 1684 → internal scroll only, box stopped growing; composer 221px; panel layout intact. Shot after-c-maxheight-panel.png — PASS.
  - **(d) send leg:** Shift+Enter inserted "\n" without sending (taValue ends "\n"); Enter sent; draft cleared → box back to 46px immediately; Send disabled while busy; genuine agent reply rendered ("A1:\n42" — read from the real sheet through MCP); final box at min. Shots after-d-shiftenter.png, after-d-reply-panel.png — PASS.
- Issue #2 acceptance (composer always renders when the panel is open): unchanged — the `{tab === 'chat' && ...}` block still renders the composer unconditionally on the chat tab.
- No push made (parent's job). progress.md untouched. Port block 9100-9109 held (web on 9102, diag probe on 9104 — both within the block).

## Notes for parent
- The `#25` number is cited; the issue body was written by the parent's filing flow.
- Cross-findings for other workers (observed, not fixed by me):
  1. **Stale-session 409 wedge** on /api/engine/open ("engine already owns a different file") after rapid stack restarts with reused data — the sibling F-3/F-4 cross-finding, reproduced twice on my stack.
  2. **React #185 boot crash** traced to a contaminated shared `apps/web/dist` (concurrent ribbon worker rebuilt it mid-edit; my stack re-copied it). Current tree boots fine.
  3. Rapid restarts left orphaned backend generations (3 engines); kill via pkill pattern before restarting, not just pid files.
