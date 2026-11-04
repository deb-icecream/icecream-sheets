# Agent Decisions Addendum — 2026-10-21 (user directives, binding)

Consolidates every AI-agent decision the user made on 2026-10-21 (17:08–18:03 PDT).
Authority: design-docs/ai-agent.md governs where anything here is silent. These decisions
extend the 12-case matrix in BRIEF.md; the coordinator's final report must show a verdict
+ evidence for EVERY numbered item below. A case without evidence = NOT RUN.

## A. Prompting guardrails
1. **Input cap: 2,000 characters per user prompt** (configurable), enforced server-side in
   the agent runtime. The cap counts ONLY what the user types/pastes — never the system
   prompt, memories, or tool results. Over-cap → rejected with a message naming the limit;
   longer content belongs in a file/data source the agent reads via tools.
   (The user's 10,000 figure was an abuse example, NOT the limit.)
2. **Per-user rate/concurrency limits + output bounds**, server-side.
3. Validation: case 13 (over-cap paste rejected, limit named, sheet unchanged; a legitimate
   ~1,500-char request still works).

## B. Scope — what the agent may answer
4. The agent answers ONLY from two sources: **(1) the data in context** — the user's
   sheets, files, and connected data reachable through its tools; **(2) Icecream-Sheets-
   specific product knowledge** — features, functions, how-to.
5. EVERYTHING else is declined politely with a redirect: general knowledge, trivia, news,
   chit-chat. Named examples from the user: "what is the weather today", "who is Einstein?".
   It is a scope rule, not a topic filter; the agent never answers from the model's
   general knowledge.
6. Validation: case 14 (weather declined), case 16 (Einstein declined), case 15 (in-scope
   borderline data question still works), case 17 (product how-to, e.g. "how do I create
   a pivot table?" / "what does XLOOKUP do?" → answered from product knowledge).

## C. Agentic execution — tool calls
7. The agent acts ONLY through versioned MCP tools (ai-agent.md §2) — no private path to
   the engine or storage. Prompting must reliably DRIVE tool calls: read → compute →
   write → re-read chains execute as real tool calls with transcripts as evidence
   (case 5), including the wider features (cases 8–12) and app generation (case 3 route B).

## D. Memory — both kinds, validated live
8. **Session memory**: the current session's thread state (ai-agent.md §9, §12;
   packages/service/src/agent/threads.ts — per-user versioned thread records in the
   service metadata store, checkpointed after every completed turn).
   Validation: case 19 — recall something established earlier in the SAME session and use
   it correctly.
9. **Long-term user memory**: facts the agent explicitly saves about the user across
   sessions, operated ONLY as versioned MCP tool calls (load/save/update memory,
   ai-agent.md §12 — no private memory channel).
   Validation: case 20 — session 1 saves a user fact via the memory tools; a NEW session
   recalls and uses it; tool-call transcripts for both.
10. If any of §D is missing in code, BUILD it per the design doc and report precisely
    what was missing.

## E. Architecture facts (verified 2026-10-21, not open for redesign)
11. The component is named **AI Agent** (ai-agent.md §1), living in
    packages/service/src/agent (runtime.ts, threads.ts, intentRouter.ts, backends.ts).
12. **LangGraph is NOT used and must NOT be introduced** — ai-agent.md §12: "No
    third-party orchestration library holds the thread state." The runtime is our own.
    Flag conflicts instead of deviating.
13. Model: Vertex AI gemini-2.5-flash-lite (VERTEX_DEFAULT_MODEL) for all live runs;
    test backends never touch the live path.
