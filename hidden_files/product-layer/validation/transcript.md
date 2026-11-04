# Product-layer stack validation — 2026-10-21T23:34:39Z
gateway http://127.0.0.1:18100, engine http://127.0.0.1:18101, scratch /tmp/pl-val
fixtures: real.xlsx=4813 B, exact.bin=1285214 B sha256=d8fa7ab6f685c3f256141f1e7a2bea0ffe31e365dffaa19c3bac59954f80e567
gateway up (unauthenticated /api/files -> 401, as expected)
PASS  d1 login tier field (= default)
PASS  d1 JWT attrs.tier (= default)
PASS  d1 created 10 files (= 10)
PASS  d1 11th create code (= FILE_LIMIT_REACHED)
PASS  d1 grant at full count code (= FILE_LIMIT_REACHED)
PASS  d2 grant 1,285,215 status (= 413)
PASS  d2 grant 1,285,215 code (= UPLOAD_TOO_LARGE)
PASS  d2 grant 1,285,215 limit (= 1285214)
PASS  d2 grant 1,285,214 issued fileId file-cf43fbe0-18a5-4054-a926-44cde42ed5bb
PASS  d2 staging PUT status (= 200)
PASS  d2 complete-upload sizeBytes (= 1285214)
PASS  d2 record origin (= upload)
PASS  d2 download round-trip sha256 (= d8fa7ab6f685c3f256141f1e7a2bea0ffe31e365dffaa19c3bac59954f80e567)
PASS  d2 real.xlsx PUT (= 200)
PASS  real.xlsx catalogued, object uploads/a403f5d547acdb95/file-5a42cab1-bef8-4d82-a1c4-75e11510aae0.xlsx
open handshake: engineUrl=http://127.0.0.1:18101 sessionId=sess_99506b2d-0143-4d42-be95-f0852d480899
PASS  engine /load/storage-ref sheets (= Data)
PASS  engine /load/storage-ref echo (= uploads/a403f5d547acdb95/file-5a42cab1-bef8-4d82-a1c4-75e11510aae0.xlsx)
PASS  engine read B1 (=A1+1) (= 42)
PASS  p1 login tier field (= pro)
PASS  p1 (pro) grant 5,000,000 B issued
PASS  p1 created 11 files (no count cap) (= 11)
PASS  d2 GET p1's file status (= 404)
PASS  d2 open p1's fileId status (= 404)
PASS  recents: last-opened file first (= file-5a42cab1-bef8-4d82-a1c4-75e11510aae0)

RESULT: 24 passed, 0 failed
