#!/usr/bin/env bash
#
# Assemble the debug APK, then install and launch it on an emulator.
# Thin wrapper around run.sh --build; all other options are passed through.

set -euo pipefail

exec "$(dirname "${BASH_SOURCE[0]}")/run.sh" --build "$@"
