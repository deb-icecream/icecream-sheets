# LANDING PAGE REDESIGN — Apple-launch-page standard (user direction, 2026-10-22 ~07:15 PDT)

The user looked at the production homepage and rejected it: "it looks like it is written by an AI." His direction, in substance:

- **Model: Apple's iPhone product launch pages.** Scroll-driven storytelling — you scroll and things appear. One idea per screen, huge confident type, big real product visuals, sections that reveal as they enter the viewport, generous negative space. Interactive and cool, not a brochure.
- **Copy must not read as AI-written.** No marketing fluff, no buzzword filler ("revolutionize", "unlock the power of", "seamless", "leverage", "delve"), no emoji bullets, no generic superlatives. Write like Apple's product team: short declarative headlines, concrete claims, real numbers, every sentence earning its place.
- **Mobile is a first-class target — for the homepage only.** It must look and scroll beautifully on an iPhone (390×844, 375×667) and hold up on iPad widths (768/820). Native touch scrolling — reveal animations ride the scroll, never hijack it.
- **Scope: the homepage ONLY.** The spreadsheet app, the Workspace, everything else — untouched.

## What exists

`apps/web/src/product/LandingPage.tsx` + its product CSS, built by the product-layer program: hero with the dashboard screenshot, the two pillars (AI-NATIVE, DATA-NATIVE), a Default-vs-Pro section, sign-in/workspace CTAs. Routing contract (do not break): a bare logged-out visit shows the landing page; file/share links go to login; CTAs lead to sign-in/workspace. The hero screenshot (dashboard sheet, 1600×1000) lives at `hidden_files/direct-save-pass/tour-p75/p75ds-sheet-12-Dashboard.png`; more real screenshots exist across the program records (grid, charts, co-authoring) — use REAL product screenshots, never mockups or stock.

## The redesign

1. **Structure (Apple launch-page grammar):**
   - Hero: product name, one short headline that says what it is, one supporting line, the dashboard visual large, sign-in CTA. Nothing else competing.
   - Scroll narrative sections, one claim each, revealed on scroll: (a) the AI agent that actually works your sheets (real example: ask a question, it reads the data and answers; ask for a change, it makes it); (b) your data anywhere — a spreadsheet is a view over your data: Excel files, CSVs, databases, live sources; (c) real Excel compatibility — 517 of Excel's 523 functions, published benchmark 463/465 (99.57%), real files open/save loss-free; (d) co-authoring — multiple people in the same sheet, live; (e) Default vs Pro (Default is never labeled "free": uploads up to ~1.3 MB per file, 10 files; Pro unrestricted); (f) final CTA.
   - Every claim must be true of the shipped product and traceable to the program records. When in doubt, cut the claim.
2. **Motion:** IntersectionObserver-driven reveals (fade/rise/scale), CSS transitions, sticky visual moments where they serve the story. `prefers-reduced-motion` disables the animation layer completely (content fully visible without it). No scroll-jacking, no horizontal-scroll traps, no autoplaying heavy media.
3. **Sign-in (per the user's ruling the same morning):** the page's sign-in action is **"Sign in with Google"** — direct, one button. No other sign-in surface exists on the page.
4. **Mobile:** fluid layout from 360 px up; type scales down gracefully, never below readable; tap targets ≥44 px; zero horizontal overflow at any width; images responsive (srcset or CSS-sized, compressed); the scroll story works identically with touch.

## Hard constraints

- ONLY `LandingPage` + its styles (+ any image assets it needs). No grid, Workspace, settings, or app-shell changes. Routing contract unchanged.
- WCAG 2.2 AA: contrast, focus visibility, reduced motion, semantic landmarks.
- Build/validation uses the house flow: local stack build (`npm run build:local-stack` + `scripts/verify-dist.mjs`), never a bare vite build for validation.
- Do NOT deploy anything — the deploy coordinator owns deploys; this work lands in the tree and the parent will order a rebuild + hosting redeploy.
- Do NOT touch progress.md. Checkpoint into `hidden_files/landing-redesign/REPORT.md` FIRST and after each landed piece (daemon restarts are frequent). TMPDIR under ~/workspace.

## Validation (required — screenshots self-inspected, in REPORT.md)

- Desktop 1440 px and iPhone 390×844 (+ a 375 px and an iPad 820 px pass): full scroll sequence captured top → bottom; every reveal state visible; no horizontal overflow (assert scrollWidth == clientWidth at each width); text legible at phone widths.
- Copy audit: the final copy pasted into REPORT.md, checked line by line against the no-fluff rule (any buzzword found = rewrite).
- Reduced-motion pass: animations off, all content visible.
- The sign-in CTA path works from the landing page on the local stack (click → login surface → Google sign-in offered; deep-link stash/return unaffected).
- Product/web test suites green; tsc clean for the touched files.
