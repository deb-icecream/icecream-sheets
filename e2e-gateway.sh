#!/bin/bash
# End-to-end gateway test (spec c): start all services + gateway locally,
# then verify: auth enforcement (401), rate limiting (429), engine round-trip
# through the gateway, and service routing.
set -u
wait_port_free() { # port
  for i in $(seq 1 20); do
    ss -tln 2>/dev/null | grep -q "127.0.0.1:$1" || return 0
    sleep 0.5
  done
  echo "WARNING: port $1 still busy after 10s" >&2
  return 1
}
# Stop any stale services from earlier runs (self-excluding patterns).
for svc in gateway engine vault meta etl agent; do pkill -f "[n]ode dist/bin/$svc.js" 2>/dev/null; done
pkill -f "[n]ode dist/bin/http.js" 2>/dev/null
for p in 8100 8101 8102 8103 8104 8105 8106; do wait_port_free $p; done
ROOT=~/workspace/icecream-sheets
GW=$ROOT/packages/gateway
MCP=$ROOT/packages/mcp-server

export AUTH_SECRET="${AUTH_SECRET:-e2e-dev-secret}"
export ALLOW_DEV_LOGIN="${ALLOW_DEV_LOGIN:-1}"   # F-1: local stacks mint test users via POST /auth/login; the gateway bin serves it only on this explicit opt-in
export RATE_LIMIT_POINTS="${RATE_LIMIT_POINTS:-1000}"
export RATE_LIMIT_WINDOW="${RATE_LIMIT_WINDOW:-60}"

PIDS=""
start() { # name, dir, script, port
  ( cd "$2" && PORT="$4" AUTH_SECRET="$AUTH_SECRET" nohup node "$3" > /tmp/gw-"$1".log 2>&1 & echo $! > /tmp/gw-"$1".pid )
  PIDS="$PIDS $(cat /tmp/gw-$1.pid)"
}

echo "== starting services =="
start engine $GW dist/bin/engine.js 8101
start vault  $GW dist/bin/vault.js 8102
start meta   $GW dist/bin/meta.js 8103
start etl    $GW dist/bin/etl.js 8104
start agent  $GW dist/bin/agent.js 8105
# MCP over Streamable HTTP (sibling-built)
( cd $MCP && PORT=8106 nohup node dist/bin/http.js > /tmp/gw-mcp.log 2>&1 & echo $! > /tmp/gw-mcp.pid ); PIDS="$PIDS $(cat /tmp/gw-mcp.pid)"
sleep 2
start gateway $GW dist/bin/gateway.js 8100
sleep 2

echo "== health checks =="
for p in 8100 8101 8102 8103 8104 8105 8106; do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$p/health || echo "DOWN")
  echo "port $p: $code"
done

echo "== auth enforcement (expect 401) =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8100/api/engine/execute \
  -H 'content-type: application/json' -d '{"cmd":{"cmd":"recalculate"}}')
echo "no token -> $code (want 401)"

echo "== login =="
TOKEN=$(curl -s -X POST http://localhost:8100/auth/login \
  -H 'content-type: application/json' -d '{"userId":"e2e-user"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token||'NONE'))")
echo "token: ${TOKEN:0:20}..."

echo "== authed engine round-trip =="
curl -s -X POST http://localhost:8100/api/engine/execute \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cmd":{"cmd":"setCell","ref":{"sheet":"Sheet1","row":0,"col":0},"value":40}}' | head -c 120; echo
curl -s -X POST http://localhost:8100/api/engine/execute \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cmd":{"cmd":"setFormula","ref":{"sheet":"Sheet1","row":1,"col":0},"formula":"=A1*2"}}' | head -c 120; echo
echo "-- read A2 (expect 80):"
curl -s -X POST http://localhost:8100/api/engine/read \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"cell","ref":{"sheet":"Sheet1","row":1,"col":0}}'; echo
echo "-- read A1:A2 range:"
curl -s -X POST http://localhost:8100/api/engine/read \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"range","range":{"sheet":"Sheet1","startRow":0,"startCol":0,"endRow":1,"endCol":0}}'; echo

echo "== bad token (expect 401) =="
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8100/api/engine/execute \
  -H "authorization: Bearer invalid.token.here" -H 'content-type: application/json' -d '{}')
echo "bad token -> $code (want 401)"

echo "== agent service =="
curl -s -X POST http://localhost:8100/api/agent/message \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"what is 2+2?"}' | head -c 300; echo

echo "== vault (scoped refs) =="
curl -s -X POST http://localhost:8100/api/vault/store \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"user:e2e-user:api-key","secret":"s3cret"}' | head -c 120; echo
curl -s -X POST http://localhost:8100/api/vault/retrieve \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"user:e2e-user:api-key"}'; echo

echo "== meta =="
curl -s -X PUT http://localhost:8100/api/meta/kv/e2e-key \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"value":"hello"}' | head -c 80; echo
curl -s http://localhost:8100/api/meta/kv/e2e-key \
  -H "authorization: Bearer $TOKEN"; echo

echo "== rate limiting (tight limit: 3 req/min) =="
restart_gateway() { # points window
  # pkill by pattern: pidfiles proved unreliable (nohup/subshell pid drift).
  pkill -f "[n]ode dist/bin/gateway.js" 2>/dev/null
  wait_port_free 8100
  ( cd $GW && PORT=8100 AUTH_SECRET="$AUTH_SECRET" RATE_LIMIT_POINTS="$1" RATE_LIMIT_WINDOW="$2" nohup node dist/bin/gateway.js > /tmp/gw-gateway.log 2>&1 & echo $! > /tmp/gw-gateway.pid )
  sleep 2
  tr '\0' '\n' < /proc/$(cat /tmp/gw-gateway.pid)/environ 2>/dev/null | grep -E "^RATE_LIMIT_POINTS" || echo "NOTE: could not confirm gateway env"
}
# restart just the gateway with a tiny bucket, then hammer it
restart_gateway 3 60
codes=""
for i in 1 2 3 4 5; do
  c=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8100/auth/login \
    -H 'content-type: application/json' -d '{"userId":"rl-user"}')
  codes="$codes $c"
done
echo "5 rapid logins ->$codes (want 200s then 429s)"
echo "$codes" | grep -q "429" && echo "RATE LIMIT ENFORCED" || echo "RATE LIMIT NOT TRIGGERED"
# restore the normal-limit gateway for the browser test
restart_gateway 1000 60
echo "gateway restored: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/auth/login -X POST -H 'content-type: application/json' -d '{"userId":"x"}')"

echo "== pids: $PIDS =="
echo "To stop: kill $PIDS"
