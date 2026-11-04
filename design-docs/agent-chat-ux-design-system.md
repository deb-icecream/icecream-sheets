# Agent Chat UX — Design System & Streaming

Status: OWNER DIRECTIVE, 2026-10-22 ~20:45 PDT. This doc governs the agent
chat redesign. Where it conflicts with earlier chat/panel styling work, this
doc wins for the chat surface. Issue #33 (panel buttons/polish) is ABSORBED
by this program.

## 0. The bar

The agent chat must look and behave like a world-class product: clean,
calm, deliberate. Not fancy — clean. Reference class: the Gemini / ChatGPT /
Claude chat surfaces. If a screenshot of the panel could sit next to theirs
without embarrassing us, it passes. Three ingredients, all mandatory:

1. ONE design system, used consistently (tokens + components), for the
   chat AND the app's dialogs.
2. Proper typography — a deliberate font choice, a real type scale.
3. Streaming behavior that always tells the user what is happening.

## 1. Design system

Build a small, coherent design system on top of the app's existing theme
tokens (the CSS-variable themes are the color source of truth — both themes
must work). Do NOT adopt a heavy component framework; the system is tokens
plus a handful of well-built components.

### 1.1 Tokens
- Color: from the theme variables only (no hard-coded colors in chat
  components). Semantic roles: surface, surface-raised, line, text,
  text-dim, accent, danger, success.
- Spacing: a single scale (4 / 8 / 12 / 16 / 24 / 32). No arbitrary pixel
  values in chat/dialog components.
- Radii: one scale (bubbles, cards, buttons, composer harmonize — the #25
  composer radius is the anchor).
- Shadows: at most two elevations (panel, popover/dialog).
- Typography: a deliberate UI font stack for chat text (a real UI font,
  loaded efficiently — see §4), a defined scale (title / body / small /
  caption), and a mono stack for code. Line-height and measure set for
  reading, not for the grid.

### 1.2 Components (the system)
- Button: primary / secondary / ghost; sizes S / M; icon-button variant
  with a real hit area (M = 36px), hover + focus-visible states, tooltips
  where the meaning is not text.
- Message bubble: user vs agent treatments from tokens; agent answers are
  rendered markdown (see §3), not plain text in a bubble-shaped box.
- Card: for structured results (tables, tool results, app artifacts) —
  one card style, header + body, used everywhere the agent presents
  something.
- Composer: the #25 Gemini-style container is the anchor; harmonize its
  buttons with the system (send, stop, attach affordances as applicable).
- Dialog: ONE shared dialog component (title bar, standard close button,
  token styling, focus trap + return, Esc to close) — §5.
- Panel chrome: header (title, actions incl. close at system size),
  divider grip (coordinates with #34), empty state.

### 1.3 Rules
- Every interactive element in the chat comes from the system. No one-off
  inline styles for buttons/bubbles/cards in chat components.
- Both themes, WCAG 2.2 AA contrast, visible keyboard focus, and
  prefers-reduced-motion respected (animations degrade to fades).

## 2. Streaming — transport

The chat must stream. Investigate the current path first (panel →
gateway agentSvc → service runtime): today a send waits for one full
response. Implement server-driven streaming end to end where the plumbing
allows (SSE or chunked events from the service through the gateway to the
panel), carrying typed increments: thinking/plan steps, tool activity,
answer text chunks, table row batches, and block payloads (chart / code /
app). Requirements:

- The UI renders increments AS THEY ARRIVE. No fabricated typewriter
  effect over a buffered full response.
- If a backend stage genuinely emits only whole results, that stage's
  output renders atomically when it lands (the thinking indicator covers
  the wait) — and the report must say which stages stream and which do
  not, honestly.
- A Stop control cancels an in-flight generation.
- Errors mid-stream render in place, in plain language, with what was
  received kept visible — never a silent dead panel.

## 3. Streaming — presentation

1. **Thinking indicator.** Replace the static three dots with an animated
   indicator: three dots in a staggered wave (one scales/fades up while
   the others settle, rotating). It appears the moment a prompt is sent.
   Accessible label ("Thinking…"); reduced-motion → gentle fade.
2. **Chain of thought.** While the agent is thinking/planning, its
   reasoning/plan steps stream into a visually distinct "thought" region
   (dimmer, smaller, set apart). When the actual answer begins, the
   thought region AUTO-COLLAPSES to a one-line summary ("Thought for
   N steps" style) that the user can re-expand.
3. **Progressive markdown answer.** The answer streams as markdown and
   renders progressively: paragraphs as they arrive; **tables build
   row by row** as row data lands (header first, rows append, no
   re-layout jumps beyond the append).
4. **Atomic blocks.** Charts (Chart.js), code blocks, and generated app /
   React artifacts CANNOT render half-way: they appear only when their
   payload is complete. Until then, a quiet placeholder in the block's
   place (skeleton or nothing — never a half-drawn chart or broken code).
5. **Scroll behavior.** The view follows the stream while the user is at
   the bottom; if the user scrolls up, it stops following and a
   "back to latest" affordance appears. A streaming caret marks the
   in-progress answer.
6. **Message actions** (small addition, approved by the owner's
   "add what makes sense"): copy on completed answers; timestamps stay
   out of the way (hover/secondary).

## 4. Performance — lazy loading is a requirement

- The design-system-heavy surfaces (chat panel, dialogs, markdown/chart
  rendering) must be code-split and LAZY LOADED: they are not in the
  initial bundle path.
- Measure the initial bundle and time-to-first-paint before and after;
  the redesign must not materially grow the initial load (the standing
  ≤ ~3 s TTFP rule stands). The font loads with display=swap and must
  not block first paint.

## 5. Dialogs on the system

The app's dialogs (Help-tab dialogs, File dialogs, confirmation dialogs —
all of them) migrate to the shared Dialog component from §1.2: same close
button, same title treatment, same spacing/radii, token colors, Esc +
focus behavior. Dialogs are lazy loaded with the surfaces that open them.
A dialog that still hand-rolls its own chrome after this program is a
defect against this doc.

## 7. Voice — the merge (OWNER DECISION, 2026-10-22 ~21:03 PDT)

Voice command and agent chat are ONE surface, decided by the owner:

- The agent chat composer carries a mic: dictation lands in the composer
  as editable text (the user reviews, then sends — the standing
  nothing-runs-until-you-confirm principle applies to execution, and a
  dictated message is confirmed by the send itself).
- The standalone voice-command palette stays as a fast path for trivial
  one-shot commands ONLY when it matches confidently. When it cannot —
  low confidence, no real match — it must NOT force a best guess: it
  hands the utterance to the agent instead (opens the panel with the
  words in the composer, one obvious action). A confident wrong match
  like TODAY()-for-a-fill-request is the exact failure this rule exists
  to prevent (see issue #41).
- Dictation plumbing (STT final pass) is shared between both surfaces
  (see issue #42 for its payload defect).

## 8. Validation (all through the UX, local production-topology stack)

- Screenshots, both themes: panel at rest, thinking indicator mid-wait,
  thought region streaming, thought collapsed with the answer streaming,
  a streamed TABLE answer mid-build and complete, a CHART answer
  (placeholder → complete), an error mid-stream.
- The standard agent prompt set (§ of the #32 work) passes through the
  redesigned panel.
- Bundle/TTFP before vs after numbers recorded.
- Dialog spot-checks: at least the Help dialogs and one File dialog on
  the shared component, screenshots.
- Related tests only; tsc clean; no regression to docking (#39),
  divider (#34), bubble position (#35), brand nav (#31), themes (#38).

### 7.1 Clarification — ONE entry point (OWNER, 2026-10-23 ~03:00 PDT)

The owner, seeing the shipped build, restated the merge: there must
not be two floating buttons. The merge means ONE visible entry point
— the agent. Concretely:
- The standalone voice-command floating button is REMOVED from the
  spreadsheet surface (web and desktop). No second icon.
- The mic lives in the agent composer, in EVERY host mode (gateway
  web, desktop signed-in, desktop local) — #54's local-mode gap is
  part of this fix, not a separate exception.
- Speaking through the composer mic: dictation lands as editable
  text in the composer (existing rule). Where the utterance matches
  a single voice command with high confidence, the fast path may
  offer that command for one-tap confirmation (the palette's matcher
  and confirm-before-run discipline survive — as a capability behind
  the mic, not as a separate button). Anything unsure stays as text
  for the agent — never a forced guess.
Acceptance: screenshots of the spreadsheet surface showing exactly
ONE floating action (the agent), the composer mic working in gateway
mode AND desktop local mode, a confident voice command offered and
run, and an unsure utterance landing as composer text.
