#!/usr/bin/env bash
# Creates a disposable "fresh Ubuntu 24.04 server" (systemd PID 1, own Docker
# storage) for installer tests, and copies the working tree into /root/lumen as
# if it had been cloned. Harness-only extras: an optional CA bundle for networks
# with TLS inspection, and /etc/hosts entries for the .test domains.
set -euo pipefail
NAME="${1:-lumen-it}"; DOMAIN="${2:-lumen-it.test}"; CA="${LUMEN_TEST_EXTRA_CA:-}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
docker build -q -t lumen-it/ubuntu-systemd:24.04 -f "$REPO/tests/installer/Dockerfile.ubuntu-systemd" "$REPO/tests/installer" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$NAME-docker" "$NAME-containerd" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --hostname "$NAME" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v "$NAME-docker:/var/lib/docker" -v "$NAME-containerd:/var/lib/containerd" \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp lumen-it/ubuntu-systemd:24.04 >/dev/null
for _ in $(seq 1 30); do docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
if [[ -n "$CA" ]]; then
  docker cp "$CA" "$NAME:/usr/local/share/ca-certificates/test-extra-ca.crt"
  docker exec "$NAME" update-ca-certificates >/dev/null 2>&1
fi
docker exec "$NAME" bash -c "echo '127.0.0.1 $DOMAIN app.$DOMAIN matrix.$DOMAIN ops.$DOMAIN' >> /etc/hosts"
# What a clone would contain: tracked files plus new files that are not git-ignored
# (so the working tree can be tested before committing), never ignored local state.
git -C "$REPO" ls-files -z --cached --others --exclude-standard \
  | tar -C "$REPO" --null -T - -cf - \
  | docker exec -i "$NAME" bash -c 'rm -rf /root/lumen && mkdir -p /root/lumen && tar -C /root/lumen -xf -'
echo "VM $NAME ready (systemd: $(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true))"
