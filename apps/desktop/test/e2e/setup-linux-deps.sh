#!/bin/sh
# Test-only: Electron shows Linux notifications through libnotify (dlopen'ed). If the host has
# no libnotify, download the Ubuntu/Debian package and unpack it under test-output/deps — no
# system change; the e2e harness adds it to LD_LIBRARY_PATH of the app under test.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
dest="$here/test-output/deps"
if ldconfig -p 2>/dev/null | grep -q 'libnotify.so.4 '; then echo "libnotify present on the system"; exit 0; fi
if [ -e "$dest/root/usr/lib/x86_64-linux-gnu/libnotify.so.4" ]; then echo "libnotify already unpacked"; exit 0; fi
mkdir -p "$dest"
cd "$dest"
apt-get download libnotify4
dpkg-deb -x libnotify4_*.deb root
echo "unpacked libnotify into $dest/root"
