#!/usr/bin/env bash
# Installs the debug app on the running emulator and starts it. The app supports Android 8.0
# (minSdk 26) and newer; the other emulator jobs use API 35, so this checks that the oldest
# supported versions at least install the APK and keep the first screen running.
#
#   bash tests/apps/android-e2e/old-android.sh <app-x86_64-debug.apk> <output-directory>
set -uo pipefail

apk="$1"
out="$2"
pkg=io.lumen.secure
mkdir -p "$out"
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
  exit 1
fi
if ! grep -q "$pkg" <<<"$focus"; then
  echo "::error::API $api: the app's window is not in front after start"
  exit 1
fi
echo "PASS API $api: started, still running and in front after 15 s, no crash"
