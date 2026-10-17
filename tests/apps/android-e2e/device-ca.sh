#!/usr/bin/env bash
# Installs a CA certificate on an Android emulator as a USER CA and verifies it.
#
#   bash device-ca.sh <ca.crt> [android-user-id]
#
# The result is what Settings > Security > Encryption & credentials > Install a certificate >
# CA certificate produces: KeyChain stores the certificate (DER) as
# /data/misc/user/<user>/cacerts-added/<subject_hash_old>.0, owned by system, world-readable.
# Apps see it as a "user:" entry of the AndroidCAStore; only apps whose network security config
# trusts user CAs (Lumen's debug build: debug-overrides) accept certificates it issued.
# Nothing in the system CA store changes. Needs an image that allows `adb root` (google_apis).
set -euo pipefail

ca="${1:?usage: device-ca.sh <ca.crt> [android-user-id]}"
uid="${2:-0}"
dir="/data/misc/user/$uid/cacerts-added"

hash="$(openssl x509 -in "$ca" -noout -subject_hash_old)"
der="$(mktemp)"
trap 'rm -f "$der"' EXIT
openssl x509 -in "$ca" -outform DER -out "$der"
target="$dir/$hash.0"

adb root >/dev/null
adb wait-for-device
for _ in $(seq 1 30); do
  [[ "$(adb shell id -u 2>/dev/null | tr -d '\r')" == 0 ]] && break
  sleep 1
done
[[ "$(adb shell id -u | tr -d '\r')" == 0 ]] || { echo "adb root is not available on this image" >&2; exit 1; }

adb push "$der" /data/local/tmp/lumen-test-ca.der >/dev/null
adb shell "set -e
  mkdir -p '$dir'
  cp /data/local/tmp/lumen-test-ca.der '$target'
  rm -f /data/local/tmp/lumen-test-ca.der
  chown system:system '$dir' '$target'
  chmod 0755 '$dir'
  chmod 0644 '$target'
  restorecon -R '/data/misc/user/$uid'"

echo "user CA store on the device:"
adb shell "ls -lZ '$dir'"
want="$(sha256sum "$der" | cut -d' ' -f1)"
# Hashed on this side: older Android toyboxes may have no sha256sum.
got="$(adb exec-out cat "$target" | sha256sum | cut -d' ' -f1)"
[[ "$want" == "$got" ]] || { echo "the certificate on the device differs from $ca" >&2; exit 1; }
meta="$(adb shell "stat -c '%U:%G %a' '$target'" | tr -d '\r')"
[[ "$meta" == "system:system 644" ]] || { echo "unexpected owner/mode on $target: $meta" >&2; exit 1; }
if adb shell "[ -e /system/etc/security/cacerts/$hash.0 ] || [ -e /apex/com.android.conscrypt/cacerts/$hash.0 ]"; then
  echo "a system CA with the same name exists ($hash.0); refusing to continue" >&2
  exit 1
fi
echo "installed as user CA $target (subject hash $hash, owner/mode $meta, SHA-256 of DER $want)"
