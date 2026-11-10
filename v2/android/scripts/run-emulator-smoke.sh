#!/usr/bin/env bash
# Collect evidence BEFORE the emulator runner destroys the guest.
# Do not print customer secrets, tokens or VPN URLs.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p emulator-diagnostics
{
  date -u
  adb devices -l || true
  adb shell getprop sys.boot_completed || true
  adb shell getprop ro.product.cpu.abi || true
  adb shell pm list instrumentation || true
} > emulator-diagnostics/device.txt 2>&1
adb logcat -c || true
status=0
gradle :app:connectedDebugAndroidTest --no-daemon --stacktrace --info > emulator-diagnostics/gradle-instrumentation.log 2>&1 || status=$?
# Capture Android-side crash cause, not only Gradle's generic Process crashed.
adb logcat -d -b all -v threadtime > emulator-diagnostics/logcat-all.txt 2>&1 || true
adb shell dumpsys activity crashes > emulator-diagnostics/activity-crashes.txt 2>&1 || true
adb shell dumpsys dropbox --print data_app_crash > emulator-diagnostics/dropbox-crashes.txt 2>&1 || true
adb shell ls -l /data/tombstones > emulator-diagnostics/tombstones.txt 2>&1 || true
echo "== AndroidRuntime / native crash excerpts =="
grep -E -i -A 18 -B 4 \
  'FATAL EXCEPTION|Fatal signal|SIGSEGV|SIGABRT|UnsatisfiedLinkError|AndroidRuntime|INSTRUMENTATION_FAILED|Process crashed|Fatal error|libXray' \
  emulator-diagnostics/logcat-all.txt | tail -n 180 || true
echo "== Gradle summary =="
tail -n 35 emulator-diagnostics/gradle-instrumentation.log || true
echo "instrumentation exit status=$status"
exit "$status"
