#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/scripts/gwt-preflight.sh"
SCRATCH="${TMPDIR:?TMPDIR must be a dedicated scratch directory}"
fixture="$(mktemp -d "$SCRATCH/pr12-gwt-preflight.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT

# The reported failure must fail before mutating package.json or starting CMake.
if require_gwt_copy_output 0 1 "$fixture" 0 >"$fixture/refusal.log" 2>&1; then
   printf 'missing GWT output unexpectedly passed\n' >&2
   exit 1
fi
IFS= read -r refusal < "$fixture/refusal.log"
if [[ "$refusal" != *'Rebuild with --build-gwt=1'* ]]; then
   printf 'missing GWT output refusal lacks recovery instruction\n' >&2
   exit 1
fi
mkdir -p "$fixture/gwt/www"
require_gwt_copy_output 0 1 "$fixture" 0
require_gwt_copy_output 1 1 "$fixture" 0
require_gwt_copy_output 0 0 "$fixture" 0
if require_gwt_copy_output 0 1 "$fixture" 1 >"$fixture/clean-refusal.log" 2>&1; then
   printf 'clean copy-only build unexpectedly passed\n' >&2
   exit 1
fi
printf 'gwt-preflight PASS\n'
