# TOUR W3b — Data sources + guardrails + scope + memory (LIVE)

Stack: gateway :8100, engine :8101, agent :8105, MCP :8106, connectors :8108, web :4173 (signed ON).
Model: Vertex AI `google/gemini-2.5-flash-lite` via openai-compatible endpoint, user **bob**.
Fixture workbook (bob): Sales sheet (Product/Region/Amount/Quantity; Amount total = 550) + WeatherLog sheet.
Evidence rule: screenshots + transcripts + sheet read-backs per case under `cases/case-NN/`.

## Checklist
- [ ] Case 7a — CSV data source via UI dialog + agent query — verdict: NOT RUN
- [ ] Case 7b — SQL (SQLite via connectors :8108) via UI dialog + chat query + analysis — verdict: NOT RUN
- [ ] Case 13 — Oversized paste (>2,000) rejected w/ limit named + ~1,500-char legit works — verdict: NOT RUN
- [ ] Case 14 — Weather declined + redirect, sheet unchanged — verdict: NOT RUN
- [ ] Case 15 — Borderline in-scope data question works — verdict: NOT RUN
- [ ] Case 16 — Einstein declined identically, sheet unchanged — verdict: NOT RUN
- [ ] Case 17 — Pivot how-to + XLOOKUP answered (correctness judged vs app UI) — verdict: NOT RUN
- [ ] Case 18 — Earlier-session data asked in new session → answered from context — verdict: NOT RUN
- [ ] Case 19 — Session memory: total recalled + 10% written, read-back = total×1.1 — verdict: NOT RUN
- [ ] Case 20 — Long-term memory: memory_save in S1, recall (memory_load) in new session — verdict: NOT RUN

## Log
- (setup pending)
