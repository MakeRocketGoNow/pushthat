#!/usr/bin/env bash
#
# Install and launch PushThat on an Android emulator, starting the AVD first if
# it is not already running.
#
# See usage() below, or scripts/build-and-run.sh to assemble first.

set -euo pipefail

readonly DEFAULT_AVD="Pixel_9_API_35"
readonly PACKAGE="com.makerocketgonow.pushthat"
readonly APK="app/build/outputs/apk/debug/app-debug.apk"
readonly BOOT_TIMEOUT_SECONDS=300

usage() {
  cat <<'EOF'
Usage: scripts/run.sh [options]

Installs the debug APK on an emulator and launches it, booting the AVD if
needed.

Options:
  -b, --build        Assemble the debug APK first (same as build-and-run.sh)
  -a, --avd NAME     AVD to use (default: Pixel_9_API_35)
  -h, --help         Show this help

The Android SDK is located from local.properties, then ANDROID_HOME, then
ANDROID_SDK_ROOT, then ~/Library/Android/sdk.
EOF
}

# local.properties is not checked in, so fall back to the usual environment
# variables and finally to the default macOS install location.
locate_sdk() {
  local dir=""
  if [[ -f local.properties ]]; then
    dir=$(sed -n 's/^sdk\.dir=//p' local.properties | tail -1)
    dir=${dir//\\:/:} # local.properties escapes colons
  fi
  printf '%s\n' "${dir:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}}"
}

# An emulator's serial (emulator-5554) has no fixed relationship to its AVD, so
# ask each running one what it is.
serial_for_avd() {
  local want=$1 serial name
  while read -r serial _; do
    [[ $serial == emulator-* ]] || continue
    name=$("$ADB" -s "$serial" emu avd name 2>/dev/null | head -1 | tr -d '\r')
    if [[ $name == "$want" ]]; then
      printf '%s\n' "$serial"
      return 0
    fi
  done < <("$ADB" devices | tail -n +2)
  return 1
}

wait_for_boot() {
  local serial=$1 deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS))
  "$ADB" -s "$serial" wait-for-device
  until [[ $("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]]; do
    if (( SECONDS >= deadline )); then
      echo "error: $serial did not finish booting within ${BOOT_TIMEOUT_SECONDS}s" >&2
      return 1
    fi
    sleep 2
  done
}

start_emulator() {
  local avd=$1 deadline=$((SECONDS + BOOT_TIMEOUT_SECONDS)) serial

  if ! "$EMULATOR" -list-avds | grep -qx "$avd"; then
    echo "error: no AVD named '$avd'. Available:" >&2
    "$EMULATOR" -list-avds | sed 's/^/  /' >&2
    return 1
  fi

  echo "Starting $avd..."
  "$EMULATOR" -avd "$avd" >/dev/null 2>&1 &

  until serial=$(serial_for_avd "$avd"); do
    if (( SECONDS >= deadline )); then
      echo "error: $avd did not come up within ${BOOT_TIMEOUT_SECONDS}s" >&2
      return 1
    fi
    sleep 2
  done
  printf '%s\n' "$serial"
}

main() {
  local avd=$DEFAULT_AVD build=false serial component

  while [[ $# -gt 0 ]]; do
    case $1 in
      -b|--build) build=true; shift ;;
      -a|--avd) avd=${2:?error: --avd needs an AVD name}; shift 2 ;;
      -h|--help) usage; return 0 ;;
      *) echo "error: unknown option '$1'" >&2; usage >&2; return 2 ;;
    esac
  done

  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  local sdk
  sdk=$(locate_sdk)
  ADB="$sdk/platform-tools/adb"
  EMULATOR="$sdk/emulator/emulator"
  readonly ADB EMULATOR

  for tool in "$ADB" "$EMULATOR"; do
    [[ -x $tool ]] || { echo "error: $tool not found or not executable" >&2; return 1; }
  done

  if $build; then
    ./gradlew :app:assembleDebug
  fi

  if [[ ! -f $APK ]]; then
    echo "error: $APK not found. Run with --build (or scripts/build-and-run.sh)." >&2
    return 1
  fi

  if serial=$(serial_for_avd "$avd"); then
    echo "Using running emulator $serial ($avd)"
  else
    serial=$(start_emulator "$avd")
  fi
  wait_for_boot "$serial"

  echo "Installing $APK on $serial..."
  "$ADB" -s "$serial" install -r "$APK"

  # Resolve the launcher activity rather than hardcoding it, so this keeps
  # working if the manifest's entry point changes.
  component=$("$ADB" -s "$serial" shell cmd package resolve-activity --brief \
    -c android.intent.category.LAUNCHER "$PACKAGE" | tail -1 | tr -d '\r')
  if [[ $component != */* ]]; then
    echo "error: could not resolve a launcher activity for $PACKAGE" >&2
    return 1
  fi

  echo "Launching $component..."
  "$ADB" -s "$serial" shell am start -n "$component"
}

main "$@"
