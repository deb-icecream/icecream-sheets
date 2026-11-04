# Deterministic inference

Decided October 13, 2026. The deterministic track that produces inspectable proposals for autocomplete, formula suggestions and cleanup. Separate from the AI Agent.

## 1. What it is

A set of deterministic analyzers that observe user patterns and propose completions, corrections and cleanups. Every proposal is inspectable and reversible. Nothing is applied without user confirmation.

## 2. Placement

Inference runs as a service-layer component. It reads through the typed view and proposes edits through the same APIs as any client, subject to authorize().

## 3. Proposals

All inference output is a proposal: a description, the proposed change, and a preview. The user accepts, rejects or modifies. Bulk proposals can be applied selectively.

## 4. Flash-fill

Pattern-based fill from examples. The analyzer synthesizes a transformation from 2-3 examples and proposes filling the column. The proposed formula is shown for inspection.

## 5. Autocomplete

Cell value autocomplete from column history and patterns. Formula autocomplete for function names and range references. Both are suggestions only.

## 6. Formula suggestions

Suggest formulas based on column headers and data patterns. The suggestion includes the full formula text for review before insertion.

## 7. Cleanup proposals

Detect inconsistent formatting, mixed types, trailing spaces and duplicate rows. Propose standardizations as a batch with per-item accept/reject.

## 8. Permissions

Inference reads only what the user can read. Proposals that would write to denied cells are not generated. Applying a proposal goes through authorize().

## 9. Out of scope for v1

Learning across workbooks. Custom inference rules. Auto-apply for any proposal type.

## Deterministic inference v2

Tracked v2 backlog. Learning across workbooks. Custom inference rules defined by the user.
