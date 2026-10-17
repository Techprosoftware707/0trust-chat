#!/usr/bin/env bash
# rec.sh <evidence-file> <workdir> <command...>: run a command, record it with its output and exit code.
out="$1"; shift; wd="$1"; shift
{
  echo "\$ cd $wd"
  echo "\$ $*"
  echo "# started $(date -u +%Y-%m-%dT%H:%M:%SZ) at $(git -C /home/user/nexus rev-parse --short HEAD)"
} > "$out"
( cd "$wd" && bash -o pipefail -c "$*" ) >> "$out" 2>&1
rc=$?
echo "# finished $(date -u +%Y-%m-%dT%H:%M:%SZ) exit=$rc" >> "$out"
exit $rc
