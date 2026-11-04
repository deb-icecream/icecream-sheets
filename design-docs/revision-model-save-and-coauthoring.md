# Revision Model — Save, AutoSave, and Co-Authoring

**Status: AUTHORITATIVE — user's design, specified 2026-10-21 (Deb, in session).
All implementations of save, autosave, download, and co-authoring MUST follow
this document strictly. Where older documents or code disagree, this document
governs for these topics; flag conflicts to the user instead of silently
choosing.**

This model is a single coherent design. It supersedes the Cycle 10 closure
W21 save architecture for the ordinary save path (per-save worker rebuild).

## 1. One live model, numbered revisions

- There is exactly ONE authoritative workbook model per session, held by the
  stateful engine (web: the server engine service; desktop: the engine in the
  Electron main process). It is always hydrated and is the source of truth.
- Every accepted edit op receives the next server-assigned revision number
  (monotonically increasing integer, one per op). Only the sequencer (§7)
  assigns revisions.
- A revision is a logical checkpoint, NOT a copy. A cell's state at revision
  R is defined as: the value/input set by the highest revision ≤ R that
  touched that cell; if none did, the cell's pre-existing value. Untouched
  cells are shared by all revisions — nothing is copied or versioned per
  cell in the model. Historical states are reconstructible only by replaying
  the op journal.
- The op journal records every op in revision order and is NEVER collapsed.
  It is the replayable history (rehydration, version reconstruction,
  catch-up).
- JOURNAL RETENTION: journal segments whose revisions are ≤ the stored
  revision may be pruned ONLY when every attached client's applied
  revision has passed the segment AND a checkpoint exists at or beyond
  it. Never prune past the slowest attached client. A reconnecting
  client whose baseRev is older than the oldest retained revision
  cannot catch up from the journal: the engine re-streams full current
  state (identical to an initial join) and the client resumes from the
  current revision. Pruning is a storage policy, never a history edit —
  within retention, the journal remains complete and ordered.
- RESYNC NEVER LOSES CLIENT EDITS: a full re-stream replaces ONLY the
  client's CONFIRMED layer. The client's unacked outbound queue is a
  separate, DURABLE structure (persisted on the client until the server
  acks each op) and a resync must never clear, overwrite, or discard it.
  After the confirmed layer is refreshed, queued ops are rebased onto
  the current revision and submitted normally (§7), landing as new
  revisions. When the client's base revision no longer exists on the
  server, the rebase cannot walk the missing revisions one by one: the
  client fast-forwards its confirmed state to current (the re-stream
  IS its new base), then replays its queued ops onto that state in its
  own order, transforming addresses against the structural changes
  visible in the new state. Net effect, in the user's words: the client
  rebases and applies its offline changes ON TOP of the current server
  state. Two honest consequences, both by design: (a) formula
  RESULTS of queued edits may differ from the client's stale preview,
  because the server recalculates them on the current base — the
  client's INPUTS are preserved, its provisional computed values are
  not authoritative; (b) a queued op whose target no longer exists
  (e.g. its sheet was deleted meanwhile, beyond what transform can
  repair) is REJECTED — visibly, per the delivery contract — and the
  client retains the rejected input locally for user recovery. It is
  never silently dropped. An implementation that reloads state by
  discarding the local queue is a data-loss defect.
- OFFLINE SCENARIO — CONFIRMED: NO DATA LOSS (user, 2026-10-21). In
  the offline/reconnect scenario (including resync past journal
  retention and takeover reconnection), the client's offline edits are
  never lost by the machinery above: typed inputs are applied as
  written (their ADDRESS may shift under structural rebase; content
  does not change); computed results may legitimately differ from the
  stale offline preview because the server recalculates on the current
  base — that is evaluation against newer data, not modification of
  the user's edits; a same-cell edit by the reconnecting client is
  sequenced at arrival and therefore wins over edits made meanwhile
  (the earlier value is what gets silently replaced, per §8).
- Client mirrors are disposable caches, never a second truth. Routing
  (local-first recalc for small workbooks) decides only where recalc happens
  first; every op is written through to the authoritative model regardless.

## 2. Serialization — always the live model, one streaming pass

- Save/export serialization is a direct, one-pass, streaming serialization
  of the live authoritative model at a pinned revision, at every workbook
  size, on web and desktop (shared implementation).
- Forbidden in the ordinary save path: workbook rebuild, source re-parse,
  op-journal replay, full snapshots, dense row-major conversion, and any
  whole-workbook object model (e.g. SheetJS worksheet objects). Memory must
  be bounded: no whole-sheet XML string, no whole-file buffer in the engine.
- Untouched package parts are copied verbatim (byte-for-byte). Changed
  sheets are regenerated row-by-row into the streaming zip.
- The serializer applies the requesting principal's permission filter
  during the pass (hidden cells never leak — see the protection model).

## 3. Save sequence (Excel semantics)

1. Finish all pending recalc first — serialize only a fully-calculated
   state.
2. Serialize into a TEMPORARY file/object. Never write over the user's
   file, never stream a half-built file to a client as a download.
3. Verify the temp file is complete (package integrity).
4. Only then ATOMICALLY replace the original (rename on the same
   filesystem; staged-object-then-commit for cloud storage).
- Any failure before step 4 leaves the original byte-identical, surfaces a
  save error, and keeps the session usable. This must be proven by a
  forced-failure test.

## 4. Save vs download

- SAVE (client-initiated) is a SIGNAL ONLY. The client sends no workbook
  data and receives no workbook bytes. The server serializes its own copy
  per §3 and commits it to file storage; the response is the saved revision
  + metadata. A client-initiated save is a FORCE SAVE (§5).
- DOWNLOAD = SAVE FIRST, THEN FETCH. The server first runs the save
  sequence so storage holds the requested revision; the client then
  downloads the bytes DIRECTLY from file storage via a gateway-issued,
  short-lived, user+file-scoped signed URL. Workbook bytes are never
  proxied through the engine or the gateway in the download path.
  (Deployed storage: GCS. Local topology: the library store, with the same
  signed-URL validation pattern.)

## 5. AutoSave — server-side continuous batch sync

Modeled on Microsoft 365 AutoSave. Single-author semantics; co-authoring
(§7–§8) reuses the same machinery unchanged.

- AutoSave is a SERVER-SIDE function. The server owns revisions, journal,
  and storage, and flushes batches itself. The client NEVER initiates
  autosave (no client autosave timers); the client only displays
  Saving…/Saved from server-reported live-vs-stored revisions.
- Edits accumulate into small coalesced batches (a short settle window,
  not one flush per keystroke). Each batch flush, in order:
  1. the batch's journal segment is written to storage (write-ahead);
  2. the stored file is materialized to the batch's cut revision via the
     §3 sequence (temp → verify → atomic replace).
  Storage jumps batch-cut to batch-cut, never half-batch. Flush points:
  settle window, idle checkpoint, tab close, session close, before a
  download, and on force save.
- A client-initiated save is a FORCE SAVE: flush the pending batch
  immediately (skip the settle window), run §3, confirm the stored
  revision.
- NO-OP RULE: if stored revision == live revision and no metadata/extras
  are dirty, a flush check does nothing — no journal write, no temp file,
  no storage write. This applies to periodic ticks and to force saves.
  Wasted saves are a defect and must be measurable (skip counter).
- Client session extras (styles/dims, defined-name extras, UI metadata)
  must sync to the server as they change (part of the op/batch stream),
  so server-side autosave is never flushing blind. An extras-only change
  is flushable content (metadata-dirty flag).
- Batch materialization: the batch's dirty set is the UNION of its ops'
  changed cells (edited + recalculated dependents). A cell changed by
  several ops in the batch is written once, at its FINAL value at the
  batch cut (highest revision ≤ cut wins, per §1). A dirty sheet is
  regenerated ONCE per batch. Structural ops (row/col insert/delete,
  sheet add/delete/rename) SPLIT a batch — per-cell collapsing by address
  is invalid across a structural change.

## 6. Edits during a save or flush — single-copy consistency

- The in-flight write produces EXACTLY its pinned/cut revision.
- Ops arriving during a write receive later revisions, apply to the live
  model immediately (never blocked), and belong to the NEXT batch.
- Mechanism: PIN + COPY-ON-WRITE STASH. While a save/flush pin is active,
  an op first stashes the pre-op state of every cell it will change (edited
  cell + dependents — the changed set the ack machinery computes) in a
  pin-scoped map. The serializer reads pinned values through the stash;
  all other cells read live (identical at both revisions). Pin release
  discards the stash. The stash is capped; past the cap, ops queue
  briefly (graceful, logged).
- After a write commits, the workbook is dirty at the newer revision;
  the next batch carries it.
- Regression tests required: cross-sheet torn-state test (dependent on a
  later sheet edited mid-save: the file must be consistent at the pin,
  the live model must hold the edit), stash unit tests, overflow test.

## 7. Co-authoring — op ordering by a single sequencer

- CONSISTENT SEQUENCING EXISTS IN EXACTLY ONE PLACE. Clients operate
  independently and cannot agree on a global order among themselves
  (asynchronous arrival makes "simultaneous" ops objectively unordered
  until an order is imposed). The global sequence is therefore created by
  the ONE owning engine instance per session — the sequencer — never by
  clients.
- Ops enter the session's single FIFO queue. The sequencer dequeues one
  op, applies it completely (input + full recalc, atomically), stamps it
  with the next revision, appends it to the journal. That stamp IS the
  total order; revisions and op order are the same thing.
- Each op carries: clientId, a per-client sequence number (keeps that
  client's own ops in order; makes retries idempotent), and baseRev (the
  last revision the sender had seen). Per-client sequence numbers are
  independent namespaces and carry NO cross-client meaning.
- At dequeue: if baseRev == current revision, apply as-is. If baseRev <
  current revision, REBASE the incoming op against the intervening
  revisions with the OT transform (collaboration.ts) before applying:
  structural shifts adjust the op's coordinates; cell-set ops need no
  transform (rule below).
- Causality is preserved: an op made after seeing revision R carries
  baseRev ≥ R and is always ordered after R. Only truly concurrent ops
  (neither author had seen the other's) receive an arbitrary relative
  order — and any order is correct provided everyone converges to the
  SAME order, which the single sequence guarantees.
- NO CROSS-CLIENT CONSISTENT SEQUENCING IS REQUIRED, AND NONE EXISTS.
  Clients are independent; their per-client sequence numbers never need
  to agree with each other, and "consistent sequencing between all the
  clients" is explicitly NOT a goal. Convergence requires only: (1) one
  total order, created by the sequencer; (2) every client applying that
  order; (3) each client's own ops kept in its own order.
- DISCONNECTED CLIENTS: a disconnected client keeps working against its
  local mirror and queues its ops in per-client sequence order. While
  disconnected it has NO shared sequence with anyone — that is expected
  and harmless. On reconnect it first catches up (missing revisions from
  the journal, in order), then submits its queued ops; the sequencer
  stamps them at arrival, so they land AFTER everything that happened
  meanwhile — including any same-cell edits made by others while it was
  away (rebase per the baseRev rule above; same-cell = last-writer-wins
  by sequence position, so a reconnecting client's queued edit wins over
  an earlier-sequenced edit of the same cell, exactly as if it had been
  connected and concurrent). The outbound queue is DURABLE on the client
  (persisted until acked); if the client's baseRev has fallen out of
  journal retention, §1's resync rule applies and the queue still
  survives it.
- SAME-CELL CONFLICT: last-writer-wins BY SEQUENCE POSITION. An op
  sequenced later overwrites the cell; an op sequenced earlier is
  overwritten by a later one. There is no privileged "server copy" —
  revisions are order, not authorship. A client's concurrent edit is NOT
  wiped by an earlier-sequenced server delta: the delta updates the
  client's CONFIRMED layer, the client's own op is still sequenced after
  it and lands on top as the next revision (see §8). The only cases where
  a client's edit does not survive: (a) the server REJECTS the op
  (authorization/protection/validation) → visible rollback to server
  state; (b) another op for the same cell is sequenced AFTER it.
- UNDO: undo is a NEW op carrying the inverse change, sequenced and
  journaled like any other op. History is NEVER rewritten, truncated,
  or rolled back — undoing revision 40 at revision 90 creates revision
  91. A user can only undo their own ops; if a later op by someone else
  has since touched the same cell, the undo still lands as a normal
  sequenced op (and so wins by position, visibly to everyone, via its
  delta). Redo likewise.
- Presence (§8) is never sequenced and never a revision.

## 8. Co-authoring — deltas and presence

- UPDATED CELLS ONLY. On each new revision, the server broadcasts to all
  attached clients a delta containing ONLY the changed cells (changed
  inputs + recalculated values), over a server-push channel (SSE).
  Whole-sheet or whole-workbook payloads on this channel are a defect.
- THE CHANNEL IS ALWAYS ON (user clarification, 2026-10-21): the SSE
  delta channel is NOT a co-authoring-only feature and is NOT activated
  by a second user joining. It is the update channel for EVERY
  service-connected session from the moment of open, including a session
  with exactly ONE user — the originator's own deltas (server-recalculated
  dependents overwriting provisional values, per the delivery contract),
  server-reported revision status (Saving…/Saved), and session events
  all flow over it. This holds identically for the web client and for
  desktop when logged in. There is NO polling fallback path for
  single-user sessions; multi-user broadcast is simply the same channel
  with more listeners. (Logged-out desktop has no server connection and
  is out of scope for this section, per §11.)
- Clients maintain two layers: CONFIRMED state (server revisions applied
  in strict revision order) and their own PROVISIONAL edits (unacked).
  Deltas update the confirmed layer; a cell with a provisional edit keeps
  displaying the provisional value until the op's ack/delta arrives, then
  the confirmed value (which, per §7, includes its own op if sequenced).
- Strict in-order application: if a delta shows a revision gap, the
  client holds it and fetches the missing revision(s) from the journal
  (catch-up endpoint) first. Never apply out of order, never skip.
- The originator's conflict resolution uses the same deltas: server
  values overwrite provisional values wherever they diverge (the existing
  delivery contract — server wins on divergence, rejection rolls back).
- PRESENCE is an ephemeral SIGNAL routed through the same stateful engine
  service: principal, sheet, selection/editing cell, heartbeat. In-memory
  only: NEVER journaled, NEVER assigned a revision, NEVER written to any
  file. Expires by heartbeat timeout. Drives co-authoring UX (avatars,
  colored selection indicators).
- OVERWRITE NOTIFICATION — DECIDED (user, 2026-10-21): SILENT, like
  Excel. When a user's cell value is overwritten by a later-sequenced
  op from another user (including a reconnecting client's queued edit
  landing on top), the delta applies with NO notification, dialog, or
  marker. The new value simply appears, as in Excel/Google. Do not add
  overwrite alerts in any client (web or desktop).

## 9. Session ownership — one file, one live server copy

- INVARIANT: at any moment, a workbook has AT MOST ONE live authoritative
  model, owned by exactly one engine instance — its session. Every user
  who opens the file joins THAT session on THAT instance. A second server
  copy of the same file is a critical defect (split-brain): two copies
  means two sequencers and two revision orders that can never be merged,
  which voids §§7–8 entirely.
- REGISTRY STORAGE: the session registry lives in the DATABASE —
  Firestore in the deployed topology (per deployment-architecture.md);
  the local topology uses the same registry interface over its local
  store adapter. It must be a shared database, never instance memory:
  the registry is the arbiter BETWEEN instances, so a store only one
  instance can see cannot arbitrate anything. One record per file:
  {fileId (key), sessionId, ownerInstance, ownerEndpoint, leaseExpiry,
  ownershipEpoch, currentRevision, storedRevision, updatedAt}. Metadata
  only — never
  cell data, never journal contents. Ownership claims and transfers are
  DATABASE TRANSACTIONS (compare-and-set on the record): the claim
  succeeds for exactly one instance because the database serializes the
  transaction, not because instances coordinate with each other. The
  owner refreshes leaseExpiry by heartbeat writes; readers treat an
  expired lease as claimable. FAIL-CLOSED: if the database is
  unreachable, an instance must NOT claim ownership or serve a file it
  cannot verify ownership of — refusing an open is acceptable, risking
  a second copy is not.
- Mechanism: the session registry (see deployment-architecture.md)
  records fileId → {sessionId, ownerInstance, lease/heartbeat}. Open
  flow: (1) a live owner exists → the opener JOINS the existing session:
  the gateway returns the session's signed access (routed to the owner
  instance) and the client attaches as a co-author per §§7–8, receiving
  current state + deltas — never a fresh model build. (2) No live owner
  → the opening instance claims ownership via an ATOMIC registry
  transaction; simultaneous first-opens race to exactly one winner, and
  the loser retries as a join (never builds a competing copy).
- Routing enforcement: an engine instance that receives an op, delta
  subscription, or open request for a file it does not own must refuse
  or redirect to the registered owner — it must never hydrate a local
  copy "to be helpful." The registry check is part of request handling,
  not a startup nicety.
- Owner loss: the owner heartbeats its lease. On lease expiry (crash,
  eviction, scale-down), exactly one instance claims ownership,
  rehydrates (stored file + journal replay + checksum verify), and
  becomes the sole owner; clients reattach to it. Brief unavailability
  during re-ownership is acceptable; two live owners never is. Lease
  hygiene: heartbeat interval must be far shorter than the lease TTL,
  and TTLs generous relative to platform clock skew, because lease
  comparisons use timestamps — the claim transaction (compare-and-set
  inside the database) is the real guard, the TTL only decides when a
  claim may be attempted.
- FENCING (why clock skew cannot create two owners): every ownership
  transfer increments ownershipEpoch inside the same claim transaction.
  The epoch is a fencing token. An owner must confirm its epoch is
  still the registry's current epoch (on every heartbeat, and it must
  stop serving if it cannot confirm); an instance that discovers a
  higher epoch — lease or no lease — fences itself immediately: it
  refuses ops and deltas and drops its authority, even though it still
  holds the model in memory. Timestamps therefore only gate when a
  takeover may be ATTEMPTED (skew can make an attempt slightly early or
  slightly late); authorization to own comes from the transaction +
  epoch, which clocks cannot forge. Two live owners remain impossible;
  a partitioned-but-alive old owner is fenced, not competed with.
- Required validation: two users open the same file → same sessionId,
  same owner, both receive deltas from one sequence; simultaneous
  first-open race → exactly one session ever created; owner killed
  mid-session → single re-owner, journal-consistent state, no divergent
  copy at any point.
- JOIN HANDSHAKE — how a newly opening client gets connected (this is
  the signed-URL engine-access flow of deployment-architecture.md,
  extended with the registry lookup):
  1. The client asks the GATEWAY to open the file (authenticated;
     gateway checks the user's permission on the file and rate limits).
     The client never talks to an engine before this step.
  2. The gateway reads the session registry for the file. Live owner →
     join that session. No live owner → an instance claims ownership
     atomically (§9 above), builds/rehydrates the model, registers, and
     becomes the target. The gateway's response is IDENTICAL in shape
     either way — join vs create is invisible to the client.
  3. The gateway returns connection information ONLY (no file bytes):
     the owner instance's engine endpoint; the sessionId; a short-lived
     signed token scoped to {user, file, session, role
     (editor/viewer), expiry} signed with the engine signing secret;
     and the session's current revision.
  4. The client connects DIRECTLY to that engine endpoint (gateway not
     in the data path) and presents the token. The engine validates the
     signature itself and checks the token's sessionId against its own
     session and the fileId against the model it owns — a token for
     another session or instance is refused. On success the engine
     attaches the client to the session: it first streams current state
     at the current revision (catch-up), then live deltas (§8) and op
     acks flow on that connection.
  5. Token expiry does not end the session: the client re-asks the
     gateway (step 1–3) for a fresh token and re-presents it. If the
     owner changed meanwhile (re-ownership after a crash), the registry
     lookup returns the NEW owner's endpoint, so reconnection lands on
     the single current copy automatically.
- TAKEOVER FROM THE CLIENT'S SIDE (walked through with the user,
  2026-10-21): when the owner instance dies, clients ARE disconnected
  — briefly — and they reconnect AUTOMATICALLY, with no user action:
  (1) the connection drops; the client shows the disconnected state and
  retries with backoff; (2) a new instance claims ownership (epoch
  incremented) and rehydrates from shared storage (stored file +
  journal replay + checksum) — the dead instance's memory was never the
  only copy of anything; (3) each client re-runs the GATEWAY lookup
  (the join handshake above), receives the NEW owner's endpoint + a
  fresh token, connects directly, catches up from its last applied
  revision (journal, or full state per §1), and submits any edits it
  queued while disconnected. Clients must treat the engine endpoint as
  LEASED information obtained from the gateway — never a permanent
  address. Expected downtime is lease-expiry + rehydration time; during
  it the file is unavailable, never duplicated.

## 9A. Session lifecycle — attach, activity, release, placement, and the per-user open cap

(User's rulings, 2026-10-23. This section governs how sessions attach,
stay alive, and end; §9 governs who may own a session. The idle rule in
deployment-architecture.md stands; this section refines its terms.)

- ATTACH AND REFCOUNT: a session tracks its attached CLIENT INSTANCES.
  A client instance is one attached app instance — a tab or window —
  not a user: one user in two tabs is two instances. Every open and
  every join attaches the opener's client instance to the session. The
  session is held while at least one instance is attached. Presence
  (§8) is a separate, ephemeral signal and is NOT the attach count.
- SIGNALED EXITS — INSTANT RELEASE: a client leaving a file signals
  its detach immediately, on BOTH leaving paths: (1) in-app navigation
  away from the file (e.g., back to Workspace); (2) window/tab close,
  via the close event with a send that survives page teardown (beacon
  or keepalive fetch — a request that dies with the page does not
  count). A detach removes that client instance only. The engine
  releases the session — checkpoint, then close — exactly when the
  attached count reaches ZERO. One client leaving must never tear the
  copy down under clients still attached.
- ACTIVITY HEARTBEAT — THE UNSIGNALED-EXIT FALLBACK: the client sends
  a session heartbeat ONLY as a record of activity: it fires on user
  actions in the file (edits, selection changes and cell navigation,
  scrolling, other mouse/keyboard activity), never on a blind timer.
  This heartbeat is the session keep-alive and is distinct from the
  owner's registry lease heartbeat (§9). Its purpose is the exits that
  cannot signal — internet drop, crash, machine or network loss — and
  the simply-idle client: when 10 MINUTES have passed since the last
  activity heartbeat, the session is checkpointed and released (the
  idle rule), and the next open rehydrates it. Signaled exits never
  wait on this expiry.
- PLACEMENT: a file with no live owner is placed on a FREE engine
  instance. The gateway tries the tier's instance pool in order; an
  instance holding a different file refuses (§9 routing enforcement)
  and the gateway tries the next; the winner is recorded as
  ownerInstance/ownerEndpoint in the registry record, and every later
  open joins via that record. Placement targets are SEPARATE Cloud Run
  services — a small fleet per tier (standard / XL) — because a single
  service's instances cannot be addressed individually, and a service
  carries one memory size while file memory needs differ by tier. A
  candidate that cannot be reached at all is skipped like a busy one;
  if every instance holds another file, the open fails with a capacity
  error; if none can be reached, it fails as unreachable. Never a
  second copy, never a queue onto a busy instance.
- PER-USER OPEN CAP: a user may hold at most 4 distinct files open at
  once (MAX_OPEN_FILES_PER_USER, one named setting) across all their
  client instances and devices. Two instances on one file count once;
  joining a file the user already has open changes nothing. Opening
  one more distinct file EVICTS the user from their least recently
  used open file, ranked by that user's own last activity on each file
  (activity as defined above; opening a file stamps it). Eviction is
  SILENT and automatic — no prompt, no notice, no interruption — and
  the new file opens immediately; the cap never refuses an open.
  Eviction detaches ONLY the evicted user's instances from that file:
  other users on the same file are completely unaffected, and the copy
  itself is released only by the zero-count rule above. Before the
  detach completes, the session's checkpoint must be confirmed current:
  the evicted user's work is never lost or altered, and re-opening the
  file rehydrates it exactly as left. If the checkpoint cannot be
  confirmed, the eviction does not happen. Purpose: bound the number
  of live engine copies (Cloud Run services) in play.
- Required validation: two clients open two different files
  concurrently → both succeed, on different instances, registry naming
  each winner; ten opens of one file → one session, attach count ten;
  leave (either signaled path) → a different file opens immediately,
  even with a pool of one instance; two instances attached, first
  leaves → the copy survives and the second keeps working, second
  leaves → released; a client that vanishes without signaling → freed
  by the idle expiry alone, and re-opening rehydrates its work exactly;
  cap: a fifth distinct open silently evicts the user's
  least-recently-active file (activity order, not open order), a
  collaborator on the evicted file keeps working uninterrupted, and
  the evicted user's edits are present exactly on re-open.

## 9B. Agent engine routing: open-time signed direct link, three layers

(Owner's routing ruling 2026-10-23, corrected 2026-10-23 23:05 PDT,
refined 2026-10-23 23:14 PDT; governs the agent path after #99. The
agent previously bound to the principal's most-recently-updated live
session across ALL open files — the wrong workbook — and fell back
silently to its own empty workbook when nothing resolved. Both are
closed by this section. The correction vetoes the first draft's
per-call registry reading: the file open provides the direct
connection once, and every call after that uses that direct signed
link. Not every read/write goes through the registry again — that
would be ridiculous.)

- LAYER 1 — BINDING: registry-resolved at open time, same instance
  and session as the grid. The agent's binding for an open file is
  established ONCE, from ONE registry lookup by fileId, at the
  agent's first turn for that file (the panel already names the open
  fileId in every message; that fileId is the link's KEY, not a fresh
  lookup trigger). The lookup returns the direct connection — the
  owner endpoint, the sessionId, and the session grant — and the
  resolved record IS the grid's session: same sessionId, same owner
  endpoint, never a guessed address. Steady-state calls (reads and
  writes alike) go DIRECTLY over that cached signed link to that
  instance. The engine-access token itself is minted per engine call
  from the session grant (local HMAC, short-lived); token expiry
  NEVER forces a registry trip — the token is re-minted locally.
  The registry is consulted again ONLY on link refresh: an engine
  refusal of the link (unreachable, unauthorized after retry,
  forbidden, session absent) or a disconnect/owner move, which
  surfaces as such a refusal once the old endpoint is fenced (§9).
  A refresh is exactly one registry lookup, and the permission is
  re-checked from the fresh record. A spurious stale mark costs
  exactly one re-resolution. This covers chat turns (reads and
  writes), the chart-creation sink, and app generation: one link,
  not one lookup per lane.
- LAYER 2 — CAPABILITY: the agent service resolves, and enforces,
  the user's access up front. The agent acts for the user and can
  never have more rights than the user has on that file: the
  agent's capability IS the user's resolved role on the fileId
  (creator → editor; a recorded grant → its role), resolved at bind
  and re-resolved at each refresh from the fresh record. If the
  agent lacks the capability for a requested action, the AGENT
  SERVICE refuses BEFORE the request ever reaches the engine, with
  an honest reason: a view-only file's agent refuses a write (and a
  chart creation, which is a workbook write) without contacting the
  engine at all, and a principal with no access to the file is
  refused entirely — reads and writes alike. A capability refusal
  is NOT a link refusal: it never invalidates the link, so a later
  read on the same file still reuses it. A refused write is
  reported as a failure, never as success.
- LAYER 3 — SECONDARY GATE: the engine verifies every call against
  the token's scope. Defense in depth behind layer 2, not the
  primary refusal: on EVERY read/write call the engine verifies the
  token's signature, expiry, session match, file match, and
  role-permits-action (viewer reads only; editor reads+writes).
  Token possession alone is never authorization, and the gateway's
  open-time permission check is not a substitute. (§9 step 4 already
  says the engine checks sessionId + fileId; this section makes the
  role-per-action check explicit too.) THE TWO RULES DO NOT
  CONTRADICT: the veto in layer 1 is on per-call REGISTRY trips
  (gateway/registry lookups per call); engine-side per-call token
  verification is local to the engine (no registry trip) and stays
  required. The full endpoint-by-endpoint audit, gap-closing, and
  tests for layer 3 live in issue #104 as its own task — this
  section records the principle and notes #104 as the follow-up; it
  does not expand this task's scope to the audit.
- NO tier-default address, NO cached/stale address. A record with no
  ownerEndpoint is unbound — never the tier URL, never the localhost
  fallback. An owner move (the same session id reclaimed on a new
  endpoint, registry ownerEndpoint moved) is followed through a
  refresh once the old endpoint refuses: a cached host must never
  keep calling the old address.
- A lookup failure, or a named file with no live session, surfaces as
  an honest "cannot see this file" reply — never an answer from
  another workbook, never the agent's private fallback workbook. (The
  read-side twin of #86's write-side rule: when the target cannot be
  resolved to the named file, the reply states what actually happened.)
  A link is never stored for an unbound file: unbound turns re-check
  each time, because the file may have opened meanwhile.
- The legacy path is unchanged: turns WITHOUT a fileId (MCP-direct,
  threads, /workflow, /audit, /pending, /tools/call) keep their
  documented per-call active-session resolution and private host.
  The link model above governs file-bound turns only.
- The same rule disposes #98 and constrains #100, without expanding
  this section's code scope: the web execute path must use the
  identical fileId routing (the bound owner endpoint, same
  permission check — a tier-URL execute is the same defect class),
  and reconnect must re-resolve by fileId from the registry (a
  reconnected session bound to any other file, or to no file while
  claiming to be connected, is the same defect class).
- Required validation: two files open, agent asked with the open
  file's fileId → reads AND writes land on that file's engine only;
  steady-state turns perform ZERO registry lookups (counting test);
  agent reads AND writes land on the SAME instance and session as
  the grid; the named file released → the agent answers it cannot
  see the file and touches no engine; a viewer grant → reads
  succeed, writes are refused with ZERO engine contact and the reply
  says so, and the next read still succeeds with no fresh lookup; a
  principal with no access → refused entirely with zero engine
  contact; an owner move → the next turn after the refusal reads
  from the new endpoint; a record with no endpoint → unbound, never
  the fallback URL.

## 9C. Identity — the user comes from the login token, the file comes from the client

- The client sends the fileId and NEVER a userId. The fileId is the required fact: which file the client is operating on. Identity is never asserted by the client.
- The gateway identifies the user from the logged-in user's JWT. The JWT is the only source of who the user is.
- The gateway mints the signed token from those two facts: the fileId from the client, the user from the JWT, and the permission check on that file. The token embeds {user, file, session, role, expiry} (see §9 step 3).
- The engine derives everything it needs FROM THE TOKEN ITSELF: the user information and the fileId. It validates the user's read/write capabilities against that file from the token — no client-supplied userId is trusted, and no registry trip is needed for identity. A token for file A authorizes nothing on file B; a viewer token authorizes no write; an expired or forged token authorizes nothing.
- The AI agent is the SAME model, internal: the agent is a server-side component, so it receives no signed URL — but it receives the same bundle internally (user from the principal's login, fileId from the panel's message, role from the user's access on that file) and enforces identically: the agent service refuses before engine contact when the capability is absent (primary gate, §9B layer 2), and the engine verifies every call against the token's scope behind it (secondary gate, §9B layer 3, audit in #104).
- One-line law: identity comes from the login token, the file comes from the client, everything the engine needs is inside the signed token, and nobody ever trusts a client-supplied userId.

## 10. Validation — multi-browser testing on the local deployment

User's mandate (2026-10-21): everything in this document must be TESTED,
end-to-end, on the LOCAL DEPLOYMENT (the full local stack in production
topology: gateway + engine service + session registry + storage + web
client), with MULTIPLE REAL BROWSERS acting as multiple clients. Unit
tests are supporting evidence only — no behavior in this document is
accepted on unit tests, mocks, or a single in-process client.

- Each test client is a separate browser instance/context with its own
  authenticated principal (distinct users, distinct tokens).
- CLIENT MATRIX (user, 2026-10-21): the scenarios run in THREE client
  combinations — (1) browser + browser; (2) DESKTOP + browser: the
  PACKAGED desktop app (not a dev-mode window), logged in against the
  local deployment, co-authoring the same session as a browser client
  (join, convergence, same-cell conflict, SSE deltas, presence both
  ways, service-driven autosave observed from the desktop); (3)
  LOGGED-OUT DESKTOP standalone: local file open → edit → revision-based
  save with timings vs the old snapshot path + exact parse-back (§11).
  Each combination is reported as its own line; a combination not run
  is reported NOT RUN, never implied by another combination's pass.
- Required scenarios:
  1. JOIN: two browsers open the same file → same sessionId, same owner
     instance (registry evidence), both live in one session.
  2. CONVERGENCE: edits in both browsers → both clients and the server
     agree cell-for-cell.
  3. SAME-CELL CONFLICT: simultaneous edits to one cell → the
     later-sequenced value wins on BOTH screens (LWW by sequence).
  4. DELTAS: network traffic inspection proves changed-cells-only
     payloads on the push channel (no whole-sheet payloads).
  5. PRESENCE: each browser sees the other's presence/selection;
     presence data is absent from the saved file and from the journal.
  6. STRUCTURAL REBASE: one client inserts a row while the other edits
     below it → the edit lands at the correct shifted address.
  7. DISCONNECT/RECONNECT: one client goes offline, edits (queued),
     reconnects → catch-up first, queued ops sequenced at arrival, full
     convergence.
  8. FIRST-OPEN RACE: two browsers open a never-opened file
     simultaneously → exactly one session is ever created.
  9. OWNER KILL: owner instance terminated mid-session → single
     re-owner, journal-consistent state, both clients reattach.
  10. REGISTRY FAIL-CLOSED: registry database unreachable mid-open →
      open refused, no copy created.
  11. SAVE/AUTOSAVE under co-authoring: server batch flush during an
      active two-client session → stored file parse-back exact at the
      flushed revision; no-op tick verifiably writes nothing.
- Evidence: screenshots from EACH browser at each checkpoint,
  self-inspected; registry/DB reads for ownership claims; traffic
  captures for delta payloads; parse-back diffs for saved files.

## 11. Desktop — the two modes

The desktop app has exactly two modes, and this document applies to both:

- LOGGED OUT (offline): the desktop opens local files with its local
  engine (main process, off the UI thread). Because it is the SAME
  engine, the ENTIRE revision model applies locally, unchanged: the
  local engine is the session's owner and sequencer (of one); it assigns
  revisions per op, keeps the journal, and saves by §§2–3 (one streaming
  pass over the live local model — no snapshot, no renderer-side
  serialization) with §5's batch flushing to the local file and §6's
  pin + stash semantics. The single-copy rule is trivially satisfied:
  one live local model + the file on disk. Expected and required
  effect: revision-based saving lowers desktop save time drastically,
  at parity with the web fix — this must be demonstrated by packaged-app
  timings against the old snapshot path, with exact parse-back.
  No registry, no co-authoring, no presence in this mode.
- LOGGED IN: the desktop is a client of the service EXACTLY like the
  web app. Every element of this document applies to it, explicitly:
  (a) SAME SERVER SESSION — the desktop joins the one live session for
  the file via the gateway join handshake (§9); it never receives or
  builds a separate copy of a service file. (b) Server-owned revisions
  and the single sequencer (§7) — desktop ops enter the same FIFO and
  receive revisions like any web client's. (c) SERVICE-DRIVEN SAVE —
  AutoSave is the server's (§5): the desktop client never initiates
  autosave for service files; its Save is a force-save signal; it
  displays Saving…/Saved from server-reported revisions. (d)
  INCREMENTAL UPDATES VIA THE SSE CHANNEL — the desktop receives the
  same updated-cells-only deltas over the server-push (SSE) channel
  (§8), applies them in strict revision order with journal catch-up on
  gaps, exactly as a browser does; no polling, no whole-sheet pushes.
  (e) CO-AUTHORING (§§7–8) in full — rebase on baseRev, same-cell
  last-writer-wins by sequence position, confirmed-vs-provisional
  layering. (f) PRESENCE (§8) — the desktop sends and receives presence
  signals through the engine service, shown identically (avatars,
  selection indicators); presence is never persisted. (g) Signed-URL
  downloads (§4). For service files the local engine is not the
  authority; no divergent desktop-only behavior is permitted.
- BOUNDARY OF THE ONE-COPY RULE: the invariant governs copies the
  service knows about. The same .xlsx file held outside the service (a
  local file opened logged-out, an emailed copy) is a SEPARATE file in
  a separate world — the design neither merges nor syncs it, and no
  split-brain protection is claimed across that boundary. Logging in
  and opening the service file joins the service session; any local
  copy remains whatever it was.
- Validation: logged-out mode is proven on the packaged desktop app
  (open local file → edit → revision-based save → timings + parse-back);
  logged-in mode is proven against the local deployment stack with the
  desktop client behaving identically to a web client (§10 scenarios).

## 12. Memory discipline

- Total revision-machinery overhead (journal tail, batch dirty-set,
  pin stash) scales with EDIT RATE, never workbook size. Report measured
  overhead at P95 scale in validation (journal bytes per 1k ops, stash
  size under the torn-state test).
- The model holds no per-cell history: each cell stores only its current
  input/value.
