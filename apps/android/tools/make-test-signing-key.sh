#!/usr/bin/env bash
# Creates the fixed signing key for Android TEST (debug) builds, for the GitHub secrets
# ANDROID_TEST_KEYSTORE_BASE64 and ANDROID_TEST_KEYSTORE_PASSWORD (docs/apps/release-android.md,
# section 7a). With it, every CI run signs test APKs with the same key, so a newer test build
# installs over an older one instead of failing with "App not installed".
#
#   bash apps/android/tools/make-test-signing-key.sh [output-directory]   (default ~/lumen-test-key)
#
# Needs only openssl. Writes outside the repository; nothing is printed except the public
# certificate fingerprint. This key is for test builds only: never use it for release builds,
# which need their own upload key (ANDROID_KEYSTORE_*).
set -euo pipefail

out="${1:-$HOME/lumen-test-key}"
command -v openssl >/dev/null || { echo "openssl is needed (sudo apt install openssl)" >&2; exit 1; }
if [[ -e "$out/lumen-test.p12" ]]; then
  echo "$out/lumen-test.p12 already exists; keep using it (a new key means uninstalling the test app once more)." >&2
  exit 1
fi
umask 077
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

openssl rand -base64 24 | tr -d '\n' >"$out/ANDROID_TEST_KEYSTORE_PASSWORD.txt"
# An EC P-256 key keeps the secret short (about 20 lines to copy).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 9125 \
  -subj "/CN=Lumen test builds" -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
openssl pkcs12 -export -name lumen-test -inkey "$work/key.pem" -in "$work/cert.pem" \
  -out "$out/lumen-test.p12" -passout "file:$out/ANDROID_TEST_KEYSTORE_PASSWORD.txt"
# Short lines copy reliably from a terminal; CI ignores the line breaks.
base64 -w 76 "$out/lumen-test.p12" >"$out/ANDROID_TEST_KEYSTORE_BASE64.txt"
fingerprint="$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"

cat <<EOF
Test signing key created in $out (readable only by you):
  lumen-test.p12                       the key itself; keep a private backup
  ANDROID_TEST_KEYSTORE_BASE64.txt     value for the GitHub secret of the same name
  ANDROID_TEST_KEYSTORE_PASSWORD.txt   value for the GitHub secret of the same name
Certificate SHA-256 (public; CI prints the same one for every signed test build):
  $fingerprint

Next: GitHub -> repository -> Settings -> Secrets and variables -> Actions -> New repository
secret, once for each of the two names above, pasting the file's whole content (all lines):
  cat $out/ANDROID_TEST_KEYSTORE_BASE64.txt
  cat $out/ANDROID_TEST_KEYSTORE_PASSWORD.txt
EOF
