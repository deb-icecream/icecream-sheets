# Add-on model

Decided October 13, 2026. The native add-in system for third-party code. Add-ons run worker-isolated and reach the product only through capability-scoped APIs.

## 1. What an add-on is

An add-on is a third-party code package registered in the product-owned catalog. It executes in an isolated worker, never in the service process and never with ambient authority. The only way it touches workbooks, the engine or the network is through the APIs its declared capabilities unlock.

## 2. Capability-scoped APIs

Every add-on declares the capabilities it needs: which objects it reads, whether it writes, and whether it reaches the network. Capabilities are granted per document binding by the user at install time and shown before install. An add-on with read on a table cannot write to it, and one without the network capability cannot exfiltrate. Widening capabilities later requires fresh user approval.

## 3. Worker isolation

Add-on code runs in a sandboxed worker with no direct access to the service process, the metadata store or other add-ons. CPU and memory limits apply per invocation. A crashing or hanging add-on fails only its own invocation; the host is unaffected.

## 4. Lifecycle

Installing an add-on records the grant: which capabilities, on which document, granted by whom and when. Permissions can be narrowed or revoked at any time and revocation takes effect on the next invocation. Uninstalling removes the grant and the document binding. Add-on code never persists inside workbook bytes.

## 5. Document bindings

An add-on binds to specific documents, resolved through the adapter's metadata capabilities. Every invocation carries the installing user's identity through authorize(), so the add-on can only touch what that user is allowed to touch. The add-on never elevates.

## 6. Catalog

Get add-ons opens the product-owned catalog. Listings show the declared capabilities, the publisher and the permission footprint. There is no sideloading outside the catalog in v1.

## 7. Out of scope for v1

Paid add-ons and billing. Scheduled or event-driven triggers. Add-on to add-on communication.

## Resolved decisions (2026-10-18)

**Worker resource limits (v1):** each add-on invocation is bounded by
`AddonLimits` (packages/service/src/addons/worker.ts), enforced twice —
the `node:vm` timeout for CPU plus a wall-clock watchdog, and V8
`resourceLimits` for memory:

| Limit | Default | Enforced by |
|---|---|---|
| CPU time per invocation | 5,000 ms | vm `timeout` option |
| Wall-clock per invocation | 30,000 ms | watchdog terminates the worker |
| Memory (old generation) | 128 MB | V8 `resourceLimits.maxOldGenerationSizeMb` |
| Memory (young generation) | 32 MB | V8 `resourceLimits.maxYoungGenerationSizeMb` |
| Max host-response payload | 4 MB | SharedArrayBuffer cap |

Limits are configurable per add-on in the registry (stored alongside the
manifest), per service via `AddonServiceOptions.defaultLimits`, and per
invocation via `AddonRunOptions.limits` (innermost wins). Exceeding CPU
fails the invocation with code `timeout`; exceeding memory with
`memory-limit`; the host process is never affected.

**Sideloading policy (v1):** registry-only. `AddonRegistry.install`
refuses any manifest id@version not present in the product-owned catalog
unless the caller passes the explicit `allowSideload: true` flag, which is
reserved for tests and dev tooling — there is no user-facing sideload
path. Sideloading outside the catalog is tracked for v2.

**Signature scheme:** Ed25519. Manifests carry
`signature: "ed25519:<base64>"` over the canonical manifest JSON (without
the signature field) + NUL + code bytes (see
packages/service/src/addons/signing.ts). The registry holds the trusted
public keys; `createEd25519Verifier(keys)` builds the install-time
verifier. When a verifier is configured, unsigned manifests fail closed.
Call `initSigning()` once at Node service startup.

## Add-on model v2

Tracked v2 backlog. Paid add-ons and billing. Scheduled and event-driven add-on triggers. Add-on to add-on communication.
