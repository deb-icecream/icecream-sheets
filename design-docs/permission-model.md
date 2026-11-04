# Permission model

Decided October 13, 2026. The access model for workbooks, sheets, ranges, tables and cells inside the web-service boundary.

## 1. Object tree

Every addressable object has a stable id. The tree is workbook at the root, then sheet, then range, table or named range, then cell. Permissions inherit downward. A node with no explicit entry inherits from its parent. A node with an explicit entry overrides for its whole subtree. To resolve, walk up from the target object to the first node with an explicit entry. That entry wins. The default at the root is deny. The creator is recorded as Owner at the root.

## 2. Roles

Owner: the creator, automatic. Full rights: read, write, manage permissions, delete the workbook and transfer ownership. The owner's grant cannot be removed by anyone else. Transferring ownership is owner-only.

Manager ("share with all permissions"): read, write and manage permissions within the granted subtree. A Manager can grant or revoke only levels they themselves hold, so there is no escalation. A Manager cannot modify the owner's root grant.

Editor ("edit only"): read and write cells. There is no manage bit, so an Editor cannot change permissions, share or unprotect.

Viewer ("read only"): reads through the filtered view. All writes are rejected. There is no manage bit.

The manage right is a separate bit. Granting or changing an entry on a node requires the manage right on that node. The manage right is inheritable.

## 3. Storage

The access table lives in the web service's metadata store as a system table: object id, principal, level, granted by and granted at. It is sparse. Only nodes with explicit entries get rows. It is never stored in the downloadable workbook bytes.

Anyone holding the file can strip embedded protection, so file-embedded protection is a hint only, matching Excel behavior. Real enforcement exists only inside the web-service boundary where the engine mediates every access. The boundary is the trust boundary.

## 4. Enforcement

Single choke point: authorize(subject, action, object_id). Every API calls it: cell and range reads and writes, inserts, deletes, formatting, sheet operations, formula evaluation and all MCP tools including the ones the AI Agent and third-party clients use. The inheritance walk lives inside authorize. APIs only name the target object and the action.

Reads: the storage-to-view projection is built per subject, so unauthorized cells never reach the engine. A direct read without permission returns an authorization error, never a fake empty. Formulas referencing denied cells evaluate to a permission error value.

Writes: rejected before any mutation. There is no partial application. The attempt is audit-logged.

Bulk and range operations enforce per cell. Permitted cells return. Denied cells are marked denied. Values never leak.

## 5. Identity

The JWT carries identity only: the verified user id and coarse slow-changing attributes. Per-object permissions are never in token claims. Tokens would bloat, go stale on revocation and the check needs the live tree anyway. Revocation is immediate because every check reads the store.

Reconciliation (2026-10-22, product-layer decision 2026-10-21): the product tier (Default / Pro) rides as one of those coarse slow-changing attributes — a `tier` claim stamped by the gateway at `POST /auth/firebase` (nested under `attrs`). Tier is an account-level attribute, NOT a per-object permission: per-object authorization still reads the live store on every check, exactly as above. Enforcement of tier limits (upload size / file count) is server-side. This note records the user's decision; §5's rule against per-object claims is unchanged.

## 6. Out of scope for v1

Explicit deny entries. Allow-based nearest-explicit-wins is enough. Add deny only if a real case demands it.

## Permission model v2

Tracked v2 backlog. Explicit deny entries, only if a real case demands them.
