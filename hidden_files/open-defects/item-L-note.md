# Item L (note for the sweep coordinator, from residual-(p) close-out 2026-10-22)

Same stale-token no-refresh pattern D2 fixed for downloads remains in
apps/web/src/services/collabTransport.ts: postEntry (/ops), catchUp,
postSessionExtras, postPresence, releaseOpenedSession, postDeltaAck.
These are best-effort / queue-managed paths, so severity is lower than D2,
but the handshake token TTL is 600 s: any of these firing first after the
TTL lapses on a never-reconnected session will 401. Fix shape is the one
D2 proved: route through fetchOpenedWithRefresh (401 -> gateway lookup ->
retry exactly once). Evidence: hidden_files/residual-p/REPORT.md (D2
addendum). Step 0 per sweep rules: re-derive whether each path can
actually observe a stale token before changing it.
