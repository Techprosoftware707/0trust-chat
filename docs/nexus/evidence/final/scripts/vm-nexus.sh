#!/usr/bin/env bash
# Installer check of test/unified-business-workspace: a fresh test server (systemd container,
# tests/installer/vm.sh) gets this branch's tree, then install.sh with a config adapted from
# scratchpad/lumen-it-current.conf (+ NEXUS_ENVIRONMENT=test, NEXUS_MCP_ENABLED=true).
# The document-storage deploy-wiring patch is deliberately NOT applied.
set -uo pipefail
S=/tmp/claude-0/-home-user/e6bb18e2-ef15-525e-9375-04c4a4514dbf/scratchpad
Q=$S/qa
N=/home/user/nexus
E=$N/docs/nexus/evidence/final
cd "$N" || exit 1
echo "### branch $(git rev-parse --abbrev-ref HEAD) at $(git rev-parse --short HEAD); working tree: $(git status --porcelain | wc -l) changed/untracked paths"
echo "### free disk before: $(df -h --output=avail / | tail -1)"
LUMEN_TEST_EXTRA_CA=/root/.ccr/ca-bundle.crt bash tests/installer/vm.sh lumen-it lumen-it.test || exit 10
ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' lumen-it)"
sed "s/^CALLS_PUBLIC_IP=.*/CALLS_PUBLIC_IP=$ip/" "$S/lumen-it-current.conf" > "$Q/lumen-it-nexus.conf"
printf '%s\n' "NEXUS_ENVIRONMENT=test" "NEXUS_MCP_ENABLED=true" >> "$Q/lumen-it-nexus.conf"
echo "### config (lumen-it-current.conf with the test server's IP and the two Nexus keys):"
sed 's/^/    /' "$Q/lumen-it-nexus.conf"
docker cp "$Q/lumen-it-nexus.conf" lumen-it:/root/lumen-it.conf
echo "### install (test server $ip)"
docker exec lumen-it bash -c 'cd /root/lumen && bash install.sh --config /root/lumen-it.conf --yes' > "$E/installer-install.txt" 2>&1
echo "install exit $?"
grep -E "Result:|✘|portal image|web chat app|migrated|images ready" "$E/installer-install.txt"
echo "### free disk after the install: $(df -h --output=avail / | tail -1)"
docker cp "$Q/vm-checks.sh" lumen-it:/root/vm-checks.sh
docker cp "$Q/vm-nexus-setup.py" lumen-it:/root/vm-nexus-setup.py
docker exec lumen-it bash /root/vm-checks.sh > "$E/installer-nexus-checks.txt" 2>&1
echo "checks exit $?"
tail -25 "$E/installer-nexus-checks.txt"
