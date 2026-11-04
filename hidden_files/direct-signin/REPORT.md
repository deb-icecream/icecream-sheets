# Direct Sign-In Fix — Report

Task: production "Sign in with Google" must be ONE click straight to Google's
sign-in popup — no intermediate in-app dialog. Dialog path kept only where dev
login is enabled (local/test builds).
User ruling: 2026-10-22 ~09:54 PDT. Record started: 2026-10-22.

## Steps
- [x] Trace entry points (LandingPage CTA, App.tsx logged-out/deep-link, GatewayLogin)
- [x] Identify production gating condition (dev login disabled)
- [x] Implement direct sign-in on click for production flavor
- [x] Validate (a) production-flavor build: one click -> Google chooser, screenshots
- [x] Validate (b) local-stack build: dialog + dev field intact
- [x] Validate (c) full apps/web suite + tsc clean

## Findings log

## Trace (2026-10-22)
- Flow today: LandingPage "Sign in with Google" button -> onSignIn ->
  App setShowLogin(true) -> GatewayLogin (A11yDialog modal) -> SECOND click
  on "Sign in with Google" inside dialog -> firebaseAuth.signInWithGoogle()
  (signInWithPopup) -> ID token -> POST /auth/firebase (unchanged).
- Deep link (hasLinkTarget) renders GatewayLogin dialog directly.
- App already subscribes to firebaseAuth state: 'logged-in' transition ->
  setHost(connectGatewayHost()) + setGwAuthed(true). So a direct
  signInWithGoogle() call completes login with NO GatewayLogin involved.
- Gating predicate (in GatewayLogin.tsx): devLoginEnabled =
  import.meta.env.DEV || isLocalhostGateway(client.baseUrl).
  Production flavor (deploy/build-web.sh: vite production build +
  VITE_GATEWAY_URL = deployed Cloud Run URL) => devLoginEnabled false.
- The "Sign in for the AI Agent" dialog in App.tsx is DESKTOP-only
  (isDesktop + openDesktopLogin) — not a web production entry point.
- Plan: export isDevLoginEnabled() from GatewayLogin.tsx (single source);
  App wires landing onSignIn straight to firebaseAuth.signInWithGoogle()
  when production flavor, with busy/error mirrored into LandingPage via
  new optional props (signInBusy/signInError, shown in place);
  GatewayLogin renders a plain non-dialog sign-in screen (one button) in
  production flavor for the deep-link gate; dialog unchanged when dev
  login is enabled.

## Implementation (2026-10-22)
- GatewayLogin.tsx: exported isDevLoginEnabled(client) as THE gating
  predicate (import.meta.env.DEV || localhost gateway); component uses
  it too. Production flavor now renders a plain .signin-screen (one
  Google button, error in place, config-missing note) instead of the
  A11yDialog — that path serves deep links. Dialog unchanged otherwise.
- index.css: .signin-screen styles (+ scoped .dialog-error color).
- LandingPage.tsx: optional props signInBusy / signInError; buttons
  disable + label "Signing in with Google…" while busy; error note
  (role=alert) under hero + final CTAs; header comment updated.
  product.css: .ics-lp-signin-error rule.
- App.tsx: imports isDevLoginEnabled + FirebaseAuthState type; new
  fbGateState mirror (subscribed only while gate is up); landing
  onSignIn fires firebaseAuth.signInWithGoogle() directly when
  production flavor (firebaseAuth present && !isDevLoginEnabled),
  else reveals the dialog as before. Token exchange untouched.
- tsc --noEmit on apps/web: CLEAN (exit 0).

## Validation (a) — PRODUCTION flavor: PASS (2026-10-22)
Build: deploy/build-web.sh posture (vite production mode,
VITE_GATEWAY_URL=https://icecream-sheet-gateway-7uydfzbt2a-uc.a.run.app;
web workspace build exit 0 after one restart-interrupted attempt).
Harness: hidden_files/direct-signin/harness-prod.mjs (static dist server
on :8943, chrome-headless-shell via playwright-core). Environment note:
in-browser egress needs relay.mjs (local relay adds preemptive proxy
auth; Chromium rejects credential-embedded proxy URLs, and the egress
proxy MITMs TLS so the harness context ignores cert errors). Two early
runs without the relay died as auth/internal-error — an environment
limit, not an app defect; the app surfaced that error IN PLACE on the
landing page, which also proved the error path.
Final run frame sequence (shots-prod/, self-inspected):
- prod-01-landing.png: landing, "Sign in with Google" buttons, no dialog.
- ONE click on the hero button.
- prod-02-after-click.png (+~0.6 s): buttons read "Signing in with
  Google…" (busy), NO dialog element in DOM (dialogPresent=false).
- prod-03-google-popup.png: the popup on accounts.google.com —
  "Sign in to continue to icecream-sheets.firebaseapp.com", Google's
  own sign-in page. No intermediate in-app dialog at any frame.

## Validation (b) — LOCAL-STACK flavor: PASS (2026-10-22)
Build: npm run build:local-stack (tsc + vite + verify-dist OK:
gateway=http://localhost:8100 + engineAccess=signed). The shared stack
was down, so a gateway-only instance (ALLOW_DEV_LOGIN=1, throwaway
secret) was run on :8100 for the submit leg, then killed after.
Harness: harness-local.mjs, shots-local/ (self-inspected):
- local-02-dialog.png: CTA click reveals the SAME dialog as before —
  "Sign in with Google" button, "— or —", User ID (local dev) field,
  Sign in button. DOM asserts: hasUserIdField, mentionsLocalDev,
  hasGoogleButton, hasSignInButton all true.
- local-03-after-login.png: dev sign-in (user id direct-signin-check)
  submitted against the real gateway -> gate lifted into the Workspace
  ("My files", DEFAULT tier, 0 of 10 files). Tours' login path intact.

## Validation (c) — suites: PASS (2026-10-22)
- Full apps/web vitest: 150 test files passed, 1,934 tests passed,
  0 failed (LandingPage.test.tsx 8/8 included).
- tsc --noEmit on apps/web: CLEAN (exit 0), re-run after all edits and
  again inside both validation builds.

## FINAL SUMMARY
Entry points changed:
1. Landing page CTAs (nav / hero / final — all are the same
   LandingPage signInButton): in the production flavor the click now
   calls FirebaseAuthService.signInWithGoogle() directly from App.tsx.
   One click -> Google popup. Busy state ("Signing in with Google…",
   buttons disabled) and error state (message in place under the hero
   and final CTAs, role=alert, button re-arms) come from the new
   optional LandingPage props signInBusy / signInError, fed by App's
   fbGateState mirror of the Firebase state machine.
2. Logged-out shell / deep-link gate: GatewayLogin no longer renders
   the A11yDialog in the production flavor — it renders a plain
   .signin-screen whose single "Sign in with Google" button fires
   signInWithGoogle() on click (error in place; a missing Firebase
   config shows a clear note instead of a dead screen). This is the
   first screen a deep-link visitor sees, so their one click is the
   sign-in click.
3. The "Sign in for the AI Agent" dialog is desktop-only
   (openDesktopLogin) — not a web production entry point; untouched.
Gating condition (exact): isDevLoginEnabled(client) ===
(import.meta.env.DEV || gateway base URL hostname is localhost /
127.0.0.1 / ::1), exported from GatewayLogin.tsx and now used by BOTH
GatewayLogin and App.tsx — production flavor === !isDevLoginEnabled.
Dialog path survives only where that is true (dev builds / localhost
gateway): landing button reveals the dialog with the dev user-ID
field; tours unchanged.
Untouched: the token exchange (Firebase ID token -> POST
/auth/firebase), the Firebase state machine, and all error
classification (classifyAuthError) — failures surface in place.
Screenshots: shots-prod/prod-01-landing.png, prod-02-after-click.png
(busy, no dialog), prod-03-google-popup.png (Google's sign-in page);
shots-local/local-01-landing.png, local-02-dialog.png (dev dialog),
local-03-after-login.png (Workspace after dev sign-in).
Harnesses: harness-prod.mjs, harness-local.mjs, probe.mjs, relay.mjs.
Not deployed; progress.md untouched; no git push.
