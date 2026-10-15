#!/usr/bin/env bash
# Federation test: an installed Lumen server (lumen.test, TLS_MODE=internal) and an
# independent vanilla Synapse (remote.test). Run as root on the Lumen host.
#   ./run.sh            set up remote server, run tests, keep it running
#   ./run.sh --down     remove the remote server
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
export FED_CA_DIR=/var/tmp/lumen-fedtest-ca
C() { docker compose -f "$HERE/docker-compose.remote.yml" "$@"; }
if [[ "${1:-}" == --down ]]; then C down -v; rm -rf "$FED_CA_DIR"; exit 0; fi
mkdir -p "$FED_CA_DIR"
[[ -s "$FED_CA_DIR/bundle.crt" ]] || cp /etc/ssl/certs/ca-certificates.crt "$FED_CA_DIR/bundle.crt"
C up -d remote-caddy >/dev/null
for _ in $(seq 1 30); do C exec -T remote-caddy test -s /data/caddy/pki/authorities/local/root.crt && break; sleep 1; done
C exec -T remote-caddy cat /data/caddy/pki/authorities/local/root.crt >"$FED_CA_DIR/remote-root.crt"
cat /etc/ssl/certs/ca-certificates.crt /etc/lumen/ca/caddy-local-root.crt "$FED_CA_DIR/remote-root.crt" >"$FED_CA_DIR/bundle.crt"
cp /etc/lumen/ca/caddy-local-root.crt "$FED_CA_DIR/lumen-root.crt"
install -m 0644 "$FED_CA_DIR/remote-root.crt" /etc/lumen/ca/remote-test-root.crt
C up -d remote-synapse >/dev/null
# Lumen side: trust the remote test CA for federation (test environments only).
if ! grep -qF "$(sed -n 2p "$FED_CA_DIR/remote-root.crt")" /etc/lumen/ca/bundle.crt; then
  cat "$FED_CA_DIR/remote-root.crt" >>/etc/lumen/ca/bundle.crt   # in place: same inode
fi
if ! grep -q '^FEDERATION_CUSTOM_CA=/etc/lumen-ca-dir' /etc/lumen/lumen.conf; then
  sed -i '/^FEDERATION_CUSTOM_CA=/d' /etc/lumen/lumen.conf
  echo 'FEDERATION_CUSTOM_CA=/etc/lumen-ca-dir/caddy-local-root.crt,/etc/lumen-ca-dir/remote-test-root.crt' >>/etc/lumen/lumen.conf
  (cd "$REPO" && ./lumenctl federation open >/dev/null)
else
  # Synapse reads CA files at startup only.
  (cd "$REPO" && ./lumenctl compose restart synapse >/dev/null 2>&1)
fi
for _ in $(seq 1 90); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(cd "$REPO" && ./lumenctl compose ps -q synapse)")" == healthy ]] && break; sleep 2
done
for _ in $(seq 1 60); do C exec -T remote-synapse curl -fsS localhost:8008/health >/dev/null 2>&1 && break; sleep 2; done
C exec -T remote-synapse register_new_matrix_user -c /config/homeserver.yaml -u bob -p "bob-remote-pass-123" --no-admin http://localhost:8008 >/dev/null 2>&1 || true
# One Lumen test account is reused across runs; its password lives with the test CA files.
[[ -s "$FED_CA_DIR/fedtester.pw" ]] || (umask 077; openssl rand -hex 16 >"$FED_CA_DIR/fedtester.pw")
FED_PW="Fed-$(cat "$FED_CA_DIR/fedtester.pw")"; FED_USER="fed${FED_PW:4:8}"
# Test server only: all test traffic shares one client IP, so forget the per-IP sign-in
# rate-limit counters left by earlier runs.
(cd "$REPO" && ./lumenctl compose exec -T postgres psql -qU postgres -d lumen \
  -c "DELETE FROM lumen_cache WHERE cache_key LIKE ':1:allauth:rl:%'" >/dev/null)
# The test client runs on the same Docker network as the remote server.
runpy() {
  docker run --rm --network lumen_egress --add-host lumen.test:host-gateway --add-host matrix.lumen.test:host-gateway \
    --add-host app.lumen.test:host-gateway -v "$REPO/tests:/tests:ro" -v "$FED_CA_DIR:/ca:ro" --entrypoint python \
    lumen/portal:1.0.0 /tests/federation/federation_test.py --ca /ca/bundle.crt --user "$FED_USER" --password "$FED_PW" "$@"
}
rc=0
runpy --phase connect || rc=1

echo "--- federation reachability probe (worker, notary = matrix.remote.test)"
sed -i '/^FEDERATION_PROBE_NOTARY=/d' /etc/lumen/lumen.conf; echo 'FEDERATION_PROBE_NOTARY=matrix.remote.test' >>/etc/lumen/lumen.conf
(cd "$REPO" && ./lumenctl federation open >/dev/null)
probe="$(cd "$REPO" && ./lumenctl compose exec -T worker python manage.py shell -c "from apps.ops.probes import run_probe; r=run_probe('federation'); print(r.status, '|', r.summary)" 2>/dev/null | tail -n1)"
echo "$probe"
[[ "$probe" == ok* ]] && echo "PASS worker federation probe reports external reachability" || { echo "FAIL worker federation probe: $probe"; rc=1; }

echo "--- allowlist policy (remote.test not allowed)"
(cd "$REPO" && ./lumenctl federation allowlist other.test >/dev/null)
runpy --phase denied || rc=1
probe="$(cd "$REPO" && ./lumenctl compose exec -T worker python manage.py shell -c "from apps.ops.probes import run_probe; r=run_probe('federation'); print(r.status, '|', r.summary)" 2>/dev/null | tail -n1)"
echo "probe under allowlist: $probe"
sed -i '/^FEDERATION_PROBE_NOTARY=/d' /etc/lumen/lumen.conf; echo 'FEDERATION_PROBE_NOTARY=none' >>/etc/lumen/lumen.conf
(cd "$REPO" && ./lumenctl federation open >/dev/null)
echo "federation test suite exit: $rc"
exit $rc
