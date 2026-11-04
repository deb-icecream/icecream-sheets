# Leg (a) — BROWSER + BROWSER — §10 acceptance results

Validation coordinator, 2026-10-21/22 (supersedes Worker D's
write-freeze-blocked report of 2026-10-21 19:42 PDT; that report's
Scenario 1 FAIL findings were the input to the fix pass at b0617854).

**Environment.** Shared stack (gateway :8100, engine :8101, preview
:4173) for S1–S7/S10 + Worker F proof; ISOLATED stack 2 (gateway :8200,
engine :8201, web :4273, data /tmp/lega2-data, launcher
`harness/start_stack2.py`) for S7-V3, S8, S9, S11 and the perf tours —
isolated because the parent session's always-on campaign repeatedly
restarts the shared stack and its gateway once won the :8100 bind
UNSIGNED. Both stacks verified signed-mode (tokenless/bogus → 401,
distinct `user:alice`/`user:bob` principals). Dist: `build:local-stack`
output, `verify-dist` clean, boot stamp present. Harnesses in
`harness/`, screenshots in `shots/`, machine captures in `captures/`.

**Defects found by validation and fixed in-scope** (all covered in the
final report; each with regression tests): autocomplete click-trap
committing column-history suggestions on editor open (Grid.tsx
pristine guard); queued ops' authored baseRev overwritten at submit,
defeating §7 server rebase (collabTransport); offline edits rejected
by the edit gate on any transport drop (App.tsx — gate decoupled from
transport state; non-gating "⚠ Offline — edits will queue" StatusBar
segment added); Phase-2 whole-workbook download 401 in signed mode
(direct downloadMetadata via collabTransport, proxied fallback kept);
F6 claim-then-reset for handleNew (fix pass follow-up).

## Verdicts

| # | Scenario | Verdict | Key evidence |
|---|----------|---------|--------------|
| S1 | Join (GatewayLogin UI + real xlsx upload) | **PASS** | `captures/` diag logs + `shots/`: POST /api/engine/open 200; load DIRECT to engine (ZERO proxied /api/engine/load*); ~31 boot requests total (vs 8,195 in the failed run); bob joins the SAME sessionId; registry record matches (owner engine-1, epoch 1). Wart: one boot-time POST /api/engine/session-extras 401 (app probes before a session exists; not an S1 criterion). |
| S2 | Convergence | **PASS** | DOM(alice) == DOM(bob) == server reads on the fixture workbook. Harness fix en route: lib flattenRange maps server `{kind:'null'}` cells to null (the first "FAIL" was that harness artifact). |
| S3 | Same-cell LWW | **PASS** | Bob's offline-queued A1=555 beats alice's online 111 after reconnect (later sequence position wins); connected near-simultaneous edits agree on 777 on both screens + server. |
| S4 | SSE deltas only | **PASS** | `captures/s04-results.json`, `s04b-final-results.json`, `s04b-final-solo-sse.json`: one UI edit → exactly 1 delta per client carrying only the 2 changed cells, ZERO /events requests; single-user 260-cell recalc chain → exactly 1 delta (rev 261) containing all 261 recalced cells incl. far dependents; edited cell commits EXACTLY ONCE (the Worker F one-op proof also re-passed on the signed stack: Enter/Tab/click-away = 1 POST /ops each, 0 engine 401s). |
| S5 | Presence | **PASS** | Avatars carry real identities both ways (`user:alice` "AL", selection flags both directions); absence proven: 0 presence hits across journal/segments (11 files), registry, and the saved file. |
| S6 | Structural rebase | **PASS** | `captures/s06-results.json`: bob's offline-queued A5 edit + alice's UI row-insert → bob's value lands at A6 on both screens + server; A5 ('r4') preserved. Server transform additionally proven by API test (stale setCell row 4 + concurrent insertRows → row 5/A6). |
| S7-V1 | Disconnect/reconnect (basic) | **PASS** | Full run 2026-10-22 ~00:35 UTC after the offline-gate fix: bob's 3 offline edits (A3=10, B3 '=A3*2'→20, B1=5) all queued and landed; DOM(alice) == DOM(bob) == server. A later solo re-run died environmentally (parent campaign churn) — not a product result. |
| S7-V2 | Past-retention resync | **PASS** | Bob's browser CLOSED with 2 queued edits; journal pruned past his baseRev (prunedPastBobBase: true); on reopen both edits (BOB-KEEP-1/2) resubmitted on top and landed identically on bob + alice + server — no input loss. |
| S7-V3 | Edit to since-deleted sheet | **PASS** | Isolated stack 2, `captures/s07-v3-results.json` (variant ok: true): bob's offline Sheet2 edit rejected on reconnect as obsolete with banner "input retained", retainedRejected[0].reason = 'obsolete', queue drained — exactly per design §7/§10. |
| S8 | First-open race | **PASS** | Stack 2, `captures/s08-results.json`: two concurrent opens of a fresh fileId → both 200, SAME sessionId (sess_8ce8bf37…), exactly ONE registry record, ownershipEpoch 1; browser joined. |
| S9 | Owner kill / takeover | **PASS** | Stack 2, `captures/s09-results.json`: engine SIGKILLed; lease expired; ownershipEpoch 1→2; session REHYDRATED under the SAME sessionId (engine log: checksum-verified rehydration — the harness's original new-sessionId assertion was wrong per design and was corrected); alice auto-reattached; post-kill edit landed + recalced (B1=80 → A2=87). |
| S10 | Registry fail-closed | **PASS** | `captures/s10-results.json`: registry dir moved aside → open returns 503 `{"error":"session registry unavailable"}`, NO session/token issued; dir restored cleanly. |
| S11 | Flush during session | **PASS** | Stack 2, `captures/s11-results.json`: interleaved two-client ops; batch flush caught up (revision 3 == storageRevision 3, 1 flush); stored file parse-back EXACT (alice A1=10, bob B1=20, A2=30 formula, A3='flushed' == server); no-op tick wrote NOTHING (stored-file mtime identical, journal segment set identical). |

## Perf gate (same coordinator run; full numbers in perf-evaluation.md addendum)

Tours via `hidden_files/pw2/tour.mjs` on isolated stack 2 with the
fixed dist. SAVE: P50 2,057 ms, P75 2,088 ms (cleanest run) / 3,844 ms
(contended run) vs Phase-1 like-for-like 1,742 / 2,109 ms — **no
material regression**; both tours' downloaded files parse (P50: 21
sheets; P75: 484,408 B). Engine-side P75 load: first sheet ready
620 ms, total 2,610 ms. Browser TTFP (4.9–9.5 s) was measured under
dual-stack contention on the 2-core VM and is NOT comparable to the
Phase-1 quiet-VM 0.35–0.39 s; a quiet-machine browser TTFP re-measure
remains owed (stated plainly, not waived).

## Leg (b) — reported separately (never gates the web verdict)

Packaged desktop rebuilt from the CURRENT fixed dist (staging bundle
baked `VITE_GATEWAY_URL=http://localhost:8200`, signed; AppImage
144,589,280 B). Logged-in smoke vs stack 2 (`build/desktop-smoke/
results.json`, errors: []): carol joins alice's live session (same
sessionId), grid shows A1=42/B2=62, presence both ways (AL avatar in
carol's app; both principals in alice's SSE capture), alice's B1=100
arrives via SSE delta (B2=142), carol's packaged-app edit A3=777
lands server-side (rev 2→3). Logged-out (`loggedout-results.json`):
local fixture opens with no token/session, A1=10/B1=20/B2=30 locally
recalced. **Leg (b): PASS (both halves).** Desktop unit suite:
147/147 (§ consolidated suites in the coordinator's final report).
