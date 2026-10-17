#!/usr/bin/env bash
# Installs the debug app on the running emulator and starts it. The app supports Android 8.0
# (minSdk 26) and newer; the other emulator jobs use API 35, so this checks that the oldest
# supported versions at least install the APK and keep the first screen running.
#
# With the instrumentation APK as third argument it then runs, on this Android version, the tests
# of the Rust SDK's own TLS stack against public servers (SdkTlsTest: Let's Encrypt, matrix.org,
# revoked and self-signed certificates), the certificate verifier (RustTlsTest) and the Keystore
# (KeystoreTest): sign-in's first SDK steps. The device needs internet access.
#
#   bash tests/apps/android-e2e/old-android.sh <app-x86_64-debug.apk> <output-directory> [app-debug-androidTest.apk]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
apk="$1"
out="$2"
test_apk="${3:-}"
pkg=io.lumen.secure
mkdir -p "$out"
FAILED=0
prop() { adb shell getprop "$1" | tr -d '\r'; }
api="$(prop ro.build.version.sdk)"
echo "device: Android $(prop ro.build.version.release) (API $api), ABIs $(prop ro.product.cpu.abilist)"

result="$(adb install -r "$apk" 2>&1)"
echo "$result"
if ! grep -q '^Success' <<<"$result"; then
  echo "::error::API $api: the APK did not install: $(tail -n1 <<<"$result")"
  exit 1
fi
echo "PASS API $api: installed"

adb logcat -c
adb shell am start -W -n "$pkg/.ui.MainActivity" | tr -d '\r'
sleep 15
adb exec-out screencap -p > "$out/api-$api-first-screen.png"
adb logcat -d > "$out/api-$api-logcat.txt"
crash="$(adb logcat -d -b crash 2>/dev/null | grep -A25 "Process: $pkg" || true)"
pid="$(adb shell pidof "$pkg" | tr -d '\r')"
focus="$(adb shell dumpsys window windows | grep -E 'mCurrentFocus' | tr -d '\r')"
echo "focused window: $focus"
if [[ -n "$crash" || -z "$pid" ]]; then
  echo "::error::API $api: the app did not keep running after start"
  echo "$crash"
  FAILED=1
elif ! grep -q "$pkg" <<<"$focus"; then
  echo "::error::API $api: the app's window is not in front after start"
  FAILED=1
else
  echo "PASS API $api: started, still running and in front after 15 s, no crash"
fi

if [[ -n "$test_apk" ]]; then
  echo
  echo "==> API $api: SDK TLS, certificate verifier and Keystore tests"
  result="$(adb install -r -t "$test_apk" 2>&1)"
  if ! grep -q '^Success' <<<"$result"; then
    echo "::error::API $api: the instrumentation APK did not install: $(tail -n1 <<<"$result")"
    exit 1
  fi
  classes=io.lumen.secure.SdkTlsTest,io.lumen.secure.RustTlsTest,io.lumen.secure.KeystoreTest
  adb logcat -c
  adb shell am instrument -w -r -e class "$classes" -e LUMEN_TLS_REQUIRE_NETWORK true \
    "$pkg.test/androidx.test.runner.AndroidJUnitRunner" >"$out/api-$api-instrumentation.txt" 2>&1
  sleep 2
  adb logcat -d -v threadtime >"$out/api-$api-tests-logcat.txt" 2>&1
  # The verdicts: the tests' own lines, the app's TLS diagnostics and the verifier's warnings.
  grep -E ' (LumenTls|Lumen|rustls-platform-verifier-android)( |:)' "$out/api-$api-tests-logcat.txt" \
    | sed -E 's/^.{19}//' | tee "$out/api-$api-tls-lines.txt"
  if python3 "$HERE/instrumentation.py" "$out/api-$api-instrumentation.txt" --junit "$out/api-$api-instrumented.xml" --expect 12; then
    echo "PASS API $api: SDK TLS, verifier and Keystore tests"
  else
    echo "::error::API $api: SDK TLS, verifier or Keystore tests failed (see api-$api-tls-lines.txt)"
    FAILED=1
  fi
fi
exit "$FAILED"
