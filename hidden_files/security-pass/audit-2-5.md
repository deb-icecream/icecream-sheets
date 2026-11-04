# Security Audit — Areas 2 (AuthZ) & 5 (Input/Injection)
Worker: 82d23262 | Started 2026-10-22 04:22 PDT | READ-ONLY, no fixes.

## AREA 2 — AuthZ: IN PROGRESS
- (a) Route inventory: gateway DONE, engine DONE, services/MCP in progress
- (b) Ownership pattern: gateway files/shares/library PASS so far (404 pattern verified in gateway.ts handlers)
- (c) Tier enforcement: PASS so far (gateway re-resolves tier from store by verified principal; caps at grant+complete+create)
- (d) Viewer gates: FINDINGS — /ops /charts /execute gated; /load* /reset /library-save /session-extras /session-bind-library /session/release /protection/* /language NOT gated

## AREA 5 — Input / Injection: IN PROGRESS
- all PENDING

## FINDINGS (draft)
- F1 CRITICAL: POST /auth/login unauthenticated, mints JWT for ANY userId; no prod gate in gateway.ts:486 or bin/gateway.ts; deploy/services/gateway.yaml ingress=all uses same bin -> full impersonation/account takeover in prod.
- F2 MEDIUM: GET /auth/__audit unauthenticated (gateway.ts:595) leaks last-500 audit entries (principals, paths, statuses).
- F3 HIGH: viewer-role tokens can call ungated mutating engine routes (/load replaces live workbook, /reset blanks session, /library-save persists, /protection/* mutates protection, /session/release evicts) — engineSvc.ts route handlers lack the role check present at 4332/4369/4414.

---
COORDINATOR NOTE (2026-10-22): this worker's full findings (its F1-F17 numbering) were delivered in its completion handoff and are folded into hidden_files/security-pass/REPORT.md under unified numbering F-1..F-26. Mapping: its F1=F-1, F2=F-3, F3=F-9 (subsumes F-8), F4=F-10, F10=F-11, F11=F-12, F12=F-13, F13=F-14, F14=F-15, F9=F-4, F7=F-6, F5-note=F-24, F16-note=F-25, F15-note=F-26. Coordinator verified its Critical/High claims in code; F-11 additionally probe-confirmed.
