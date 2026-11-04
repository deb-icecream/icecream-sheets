# FIX-D — Gateway agent chat drops analysis charts

Date: 2026-10-21. Scope honored: source edits only in
`apps/web/src/services/remoteAgent.ts` + `apps/web/src/services/remoteAgent.test.ts`.
`AgentChat.tsx` was **not** touched (the type flow did not require it — see
below). No dist rebuild, no stack restart, no git push.

## The defect (per recon wiring-report §1)

The agent service forwards the analysis chart, but `RemoteAgentBackend`
dropped it at the last hop, so `AgentChat`'s `ChartCanvas` rendering never
fired in gateway mode (it works with the local in-process runtime).

## Exact shapes on both sides

### Local path (the behavior to match)

- `packages/service/src/agent/types.ts:115-118` —
  ```ts
  export interface AgentChartAttachment {
    title: string;
    config: ChartConfiguration; // chart.js
  }
  ```
  Exported from `@icecream-sheets/service` (`packages/service/src/index.ts:566`).
- `packages/service/src/agent/types.ts:131` — `AgentReply.chart?: AgentChartAttachment`
  (optional; absent/undefined when the turn produced no chart).
- `packages/service/src/agent/runtime.ts:639-652` — `chartAttachment()`
  returns `{ title: string; config: ChartConfiguration } | undefined`
  (title defaults to `'Analysis'`; config from `toChartConfiguration(spec)`),
  assigned directly at `runtime.ts:622` and `runtime.ts:629`:
  `return { threadId, message, actionsTaken: [], chart: this.chartAttachment(results) }`.
- Consumer: `apps/web/src/components/AgentChat.tsx:259` and `:283` —
  `push('agent', reply.message, reply.chart)`; render at `AgentChat.tsx:478-486` —
  `{m.chart && <ChartCanvas config={m.chart.config} title={m.chart.title} … />}`.

### Gateway emission

- `packages/gateway/src/services/agentSvc.ts:252-264` — `POST /message`
  returns JSON `{ threadId, message, needsInput, audit, chart: reply.chart ?? null }`
  (line 263). So on the wire `chart` is either an
  `AgentChartAttachment`-shaped object (`{ title, config }`, plain JSON) or
  `null`.

### Web gateway client (before fix)

- `apps/web/src/services/remoteAgent.ts` — `AgentMessageResponse` (was line
  ~76-81) had **no** `chart` field, and `send()` (was line ~89-104) built the
  returned `AgentReply` from only `threadId` / `message` / `audit` /
  `needsInput`. The chart was silently discarded.

## What I changed

### `apps/web/src/services/remoteAgent.ts`

1. Import: added `AgentChartAttachment` to the existing
   `import type { … } from '@icecream-sheets/service'` (line 13).
2. `AgentMessageResponse` (line 88): added
   ```ts
   chart?: AgentChartAttachment | null;
   ```
   matching agentSvc's wire emission exactly (attachment object or `null`,
   `?` for robustness if a response omits it).
3. `send()` return (line 114): added
   ```ts
   ...(res.chart ? { chart: res.chart } : {}),
   ```
   The chart object passes through **unchanged** (same reference / deep-equal
   JSON) into the returned `AgentReply`. When the gateway sends `null` (or
   the field is absent), the returned reply has **no `chart` key at all** —
   exactly the local path's observable behavior (`reply.chart === undefined`,
   `m.chart` falsy in AgentChat, no `ChartCanvas` rendered). `chart: null`
   is never leaked into an `AgentReply`, whose type has no `null` chart.
4. `answer()` shares `send()` (`remoteAgent.ts` `chat`/`answer` both delegate),
   so HITL-answer turns carry charts too — no separate change needed.

`AgentChat.tsx` needed no change: it already consumes `reply.chart` /
`m.chart.config` / `m.chart.title` in the exact `AgentChartAttachment`
shape now delivered.

### `apps/web/src/services/remoteAgent.test.ts`

Added `describe('RemoteAgentBackend chart passthrough')` with 3 tests,
using the file's existing mocked-`fetch` gateway harness:

1. `chat()` — mocked `POST /api/agent/message` response **with** a chart
   (`{ title: 'Revenue by month', config: { type: 'bar', data: { labels, datasets }, options } }`)
   → `reply.chart` deep-equals (`toEqual`) the mocked chart unchanged.
2. `answer()` — same mocked chart → carried through (proves the shared
   `send()` path).
3. Mocked response with `chart: null` → `reply.chart` is `undefined` and
   `'chart' in reply` is `false` (no chart on the reply).

## Test results

Command: `npx vitest run src/services/remoteAgent.test.ts` in `apps/web`.

- **Baseline (before edit):** 5 tests, **5 passed**.
- **After edit:** 8 tests (5 pre-existing + 3 new), **8 passed**.

Type check: full web-package `npx tsc --noEmit` in `apps/web` —
completed, **exit 0, no errors** (verified via `PIPESTATUS`; the whole
package was checked, not a targeted subset).

## Not done (per task scope)

- No dist rebuild and no live gateway-mode browser proof — the chart will
  only render live after the coordinated web dist rebuild/restart window.
  This fix is unit- + type-verified only.
- Nothing else in the recon report (agent↔workbook binding, app-gen, etc.)
  was touched.
