# Homepage Narrative Rebuild — REPORT (issue #45)

Spec: design-docs/homepage-narrative.md (governing). Directive: present the
product as an AI-native data workspace (data processing + visualization core);
pipeline structure: Agent -> Connect -> Process -> Visualize -> Share -> parity
credibility strip.

## Ports claimed: 9140-9149 (this program only)
- 9140: isolated web build server (this program)
- 9141: gateway (local stack, if needed)
- 9142: engine (local stack, if needed)
- 9143: service/agent (local stack, if needed)
- 9144-9149: spare

## Tree coordination
- Mine: apps/web/src/product/* only. NOT editing App.tsx, index.css, ribbon/, components/AgentChat.tsx (live-ux worker owns them).
- NEVER rebuild apps/web/dist; isolated outDir under ~/workspace/tmp-homepage.

## Log
- (start) Record created; ports claimed. Reading spec + current LandingPage.
- Copy + structure LANDED in src/product (LandingPage.tsx rewritten, product.css
  +hero eyebrow/strip classes, LandingPage.test.tsx updated):
  Hero (agent-first, NEW H1 "An AI that works on your data — in a real
  spreadsheet." + eyebrow "An AI-native data workspace") -> Agent -> Connect ->
  Process -> Visualize -> Share -> credibility strip (517/523, 99.57% 463/465,
  lossless round trips, benchmark link) -> Plans -> final CTA. Sign-in
  mechanics (signInButton/onSignIn/direct Google) byte-identical.
- Image audit so far: hero-dashboard.png (charts in-sheet, real data) KEEP ->
  Visualize; pivotchart.png (sales grid + pivot + chart, GT 4027.86) KEEP ->
  Process; collab.png (presence/two-user, sparse grid) KEEP -> Share (weakest
  of the set; noted). NEW captures owed: agent-work.png (hero, agent mid-work)
  + connect-source.png (Connect, source in flight).
- CAPTURES LANDED in apps/web/public/product/ (+960 variants via PIL):
  * agent-work.png (NEW, PROVISIONAL — panel look may change with #40; also
    shows the current Voice-pill/composer overlap, #35's known defect):
    Vertex-backed agent on the local stack wrote 4027.86 into G26 of the
    sales grid and confirmed in-panel; grid with all 24 rows beside it.
  * connect-source.png (NEW): Open data source dialog — CSV/JSON URL, REST,
    SQL, Google Sheets kinds; URL filled; "Schema preview — 24 rows" with
    inferred types + first-8-rows preview over the grid.
  Stack notes: gateway+service restarted with deployer ADC + GCP_PROJECT_ID
  so the Vertex default backend engages (without it the agent falls back to
  the heuristic suggestion backend — tour2 evidence). One stack reset for
  the #27 stale-session wedge (cross-owner join 409), as expected.
- Note: mid-run, the live-ux worker's #31 edits landed IN my files
  cooperatively (buildHomeUrl wordmark link in LandingPage nav + deepLink
  export + product.css .ics-wordmark-link) — compatible with the narrative
  page; my first isolated build predated the deepLink export and crashed
  (buildHomeUrl undefined); rebuild after their files converged = clean.

## FINAL — page as built (2026-10-22)

### Structure (in order, per design-docs/homepage-narrative.md §Six beats)
1. Nav — wordmark (home link, #31) + "Sign in with Google".
2. HERO — eyebrow "An AI-native data workspace"; H1 "An AI that works on
   your data — in a real spreadsheet."; sub built on the doc's §Positioning
   line ("the agent is the product, and the spreadsheet is how you watch it
   work"); Google button; HERO IMAGE = agent-work.png (see audit).
3. THE AGENT — "Ask. It answers. Tell it. It's done." + the doc's real
   exchange as a card (YOU "What's the total revenue in the Sales sheet?" /
   AGENT "$159,400", sourced from USER-GUIDE.md's validation record).
4. CONNECT — "Your data stays where it lives. The sheet comes to it." +
   facts (Excel files / CSV / REST and SQL) + connect-source.png.
5. PROCESS — "The cleaning and joining is a sentence now." + pivotchart.png.
6. VISUALIZE — "Ask a question. Get the picture." + hero-dashboard.png.
7. SHARE — "One sheet. Everyone in it. Live." + collab.png.
8. CREDIBILITY STRIP (one strip, per the doc's "exactly one") — eyebrow
   "And underneath, a real spreadsheet", H2 "Your Excel files, exactly as
   Excel left them.", three items: 517 of 523 functions · 99.57% (463 of
   465) with the published-benchmark link · lossless round trips.
9. PLANS — Default / Pro, unchanged copy, no "free" anywhere (test-enforced).
10. FINAL CTA — "Bring your data. Ask the first question." + Google button;
    footer line updated to the narrative ("an AI-native data workspace, on
    a real spreadsheet") + benchmark link.

### Copy decisions
- Headline: the doc prescribes no literal H1; chosen to name the category
  (AI) + the surface (a real spreadsheet) in one sayable sentence. The
  doc's §Positioning sentence appears nearly verbatim as the hero sub.
- Everything the old page claimed about Excel parity moved into the single
  strip (the doc: parity is "table stakes… worth exactly one strip").
- No buzzwords, no "free", no unsupervised-perfection claims; agent copy
  stresses visibility/control ("you watch every step… stop it, undo it").

### Image audit (every image on the page)
| file | verdict | beat | notes |
|---|---|---|---|
| agent-work.png (+960) | NEW capture | Hero / agent mid-work on real data | Vertex-backed agent wrote 4027.86 into G26 of the real sales grid, confirmed in the docked panel. PROVISIONAL: panel look may change with #40; frame also shows the known Voice-pill/composer overlap (#35). |
| connect-source.png (+960) | NEW capture | Connect — a source in flight | Open-data-source dialog: 4 source kinds, URL filled, schema preview (24 rows, inferred types) + row preview. URL is the local fixture host (captures come from the local stack, as the shipped ones did). |
| pivotchart.png (+960) | KEPT | Process — pivot + chart in the grid | Real capture from the landing program; Grand Total 4027.86 ties to the same sales data. |
| hero-dashboard.png (+960) | KEPT, moved Hero→Visualize | Visualize — charts from data | Was the generic hero; it is a charts shot, so it now illustrates Visualize. |
| collab.png (+960) | KEPT | Share — two editors, one copy | Weakest image: mostly-empty grid; its title bar still shows a raw file id (predates the #9 fix). A two-client recapture was attempted in the landing program and blocked by cross-owner join 404s; flagged as the first candidate for a refresh once #40/#31-era join behavior settles. |
Beats coverage: (a) agent mid-work = agent-work; (b) chart/visualization =
hero-dashboard + pivotchart; (c) connected source in flight =
connect-source; (d) grid with real data = agent-work + pivotchart.

### Validation
- LandingPage.test.tsx: 9/9 PASS (rewritten: pipeline section order
  agent→connect→process→visualize→share→proof→plans; narrative copy;
  5-image srcset set incl. the two new captures; facts list =
  Excel files/CSV/REST and SQL; invariants kept — exactly one Google
  action wired to onSignIn, exact "Default"/"Pro" labels, no "free").
- tsc --noEmit (apps/web): exit 0.
- Finished page self-inspected from the isolated dist at 1440 (7 bands)
  and 390 (5 bands): shots/final-1440-*.png, shots/final-390-*.png.
  All sections render; hero shows the panel exchange + 4027.86 in G26.
- Sign-in mechanics untouched: signInButton/onSignIn byte-identical;
  in this local build (no Firebase) the buttons render the dev sign-in,
  same as before my change; prod one-click-to-Google behavior unaffected.

### Files changed (all mine to change)
- apps/web/src/product/LandingPage.tsx (rewritten)
- apps/web/src/product/LandingPage.test.tsx (updated)
- apps/web/src/product/product.css (strip + hero-eyebrow classes added)
- apps/web/public/product/agent-work.png, agent-work-960.png (new)
- apps/web/public/product/connect-source.png, connect-source-960.png (new)
- (Not mine, landed cooperatively by the live-ux worker mid-run in my
  files: deepLink.ts buildHomeUrl + LandingPage wordmark link + App/
  Workspace links + .ics-wordmark-link CSS — compatible, kept.)
- NOT touched: App.tsx, index.css, ribbon/, AgentChat.tsx; apps/web/dist
  never rebuilt (isolated dist at ~/workspace/tmp-homepage/dist).

### Residuals / notes for the parent
1. agent-work.png is PROVISIONAL (see audit) — recapture after #40 lands.
2. collab.png refresh (raw file id in its title bar) — recapture when a
   two-client session is cheap again.
3. Stack evidence for captures: the agent only answers for real when the
   service/gateway run with a GCP identity (Vertex default backend);
   without it the panel falls back to heuristic suggestions (tour2 shot).
   My stack ran gateway+service with the deployer ADC + GCP_PROJECT_ID=
   dreamscapes-zero for the captures. No credentials were stored anywhere.
4. Ports 9140-9149 released (stack + REST fixtures stopped).
STATUS: COMPLETE.
