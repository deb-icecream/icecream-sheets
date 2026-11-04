# Product Homepage — Narrative

Status: OWNER DIRECTIVE, 2026-10-22 ~21:41 PDT. This doc governs the
product homepage (the landing page). It SUPERSEDES the spreadsheet-first
framing of the earlier landing copy lock; the copy-quality rules from that
lock still apply (§4).

## 1. What the product is — the one story

Icecream Sheets is an **AI-native data workspace**: its core is **data
processing and data visualization**. The spreadsheet is the surface the
data lives on — the best view humans have for data — but the product is
not "a spreadsheet," and the homepage must never present it as one.

The line: other tools added AI to the spreadsheet; this is the data
platform the AI works in, and the spreadsheet is how you watch it happen.

A visitor must be able to say, within seconds of landing: **what it is**
(an AI that processes and visualizes your data, in a real spreadsheet)
and **what it is not** (not another Excel clone with a chatbot bolted on).

## 2. Structure — the pipeline, not the ribbon

Organize the page by the data pipeline, in this order:

1. **The agent first.** The AI agent is the headline act and currently
   has NO presence on the homepage — that is the #1 miss this doc fixes.
   Show the agent working: a real conversation that takes an instruction
   and does data work.
2. **Connect** — data comes from anywhere: files, CSV/REST/SQL sources.
   The grid is a view over the data, whatever its source.
3. **Process** — the agent, formulas, and AI-generated Python clean,
   join, and transform; triggers keep it current.
4. **Visualize** — charts render on open; the agent turns a question
   into a chart or a small live app in one conversation.
5. **Share** — apps and sheets shared with their data; collaborators
   land in the same live data.
6. **The credibility floor (last, brief).** Excel parity is proof of
   seriousness, not the pitch: 517 of 523 Excel functions; 99.57%
   (463/465) on the public benchmark anyone can re-run; lossless file
   round trips. One compact strip — never the headline.

## 3. Visuals — real product, matching the story

- Every visual is a REAL screenshot of the working product (no mockups,
  no stock, and — standing rule — never an error screen).
- Required coverage: (a) the agent panel mid-work on real data;
  (b) a chart/visualization produced from data; (c) data processing —
  a connected source or a transform in flight; (d) the grid itself with
  real data in it.
- If an existing homepage image does not serve the narrative (check the
  six product images already shipped), replace it with a fresh capture
  from the local production-topology stack, at desktop and narrow
  widths, cropped to the story it illustrates.
- Screenshots must be current-build: if the chat redesign (issue #40)
  changes the panel's look materially, recapture after it lands rather
  than shipping the old panel as the face of the product. Sequence
  accordingly and say so in the report if a capture is provisional.

## 4. Copy rules (unchanged, still binding)

- A person must be able to say every sentence out loud (owner's test).
- No buzzword stuffing; no "free" anywhere on the page.
- Claims must be true of the shipped product today: sources = files,
  CSV/REST/SQL (JSON not separately toured; Postgres driver pending);
  the agent's strengths stated without claiming unsupervised perfection.

## 5. Validation

- The parent (Icecream) verifies personally: read the rendered page top
  to bottom and check it against §1–§3 — the narrative must HOLD on the
  page as built, not as briefed.
- Screenshots of the finished page at desktop + phone widths, self-
  inspected; every image on the page accounted for (kept / replaced /
  new, and which narrative beat it serves).
- Related tests; tsc clean; no regression to the landing page's existing
  behavior (sign-in entry points, one-click-to-Google intact).
