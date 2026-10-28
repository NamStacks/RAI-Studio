#!/bin/bash
# Rebuild rsession, rpostback and diagnostics for both architectures with the 0.1.63 version env and path remapping, then stage the packaged copies.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/plan-env-0163.sh"
# The client in release-11 was compiled as org.rstudio.studio.RStudio; keep the ninja rule text identical to that so it does not re-run GWT.
export GWT_MAIN_MODULE=RStudio
S=${STAGE:?set STAGE to the build staging folder}
SRC=$S/universal-build-preparation-01/builder-source-49a8
OUT=$S/beta2-work/native-out
# The more specific map goes last: clang applies the last matching map.
PFX="-ffile-prefix-map=$S=build -ffile-prefix-map=$SRC=src"
# COMMIT is the id of the source commit the binaries report in About.
: "${COMMIT:?set COMMIT to the source commit id}"
# SKIP_ARM=1 resumes after a failed x86_64 step and keeps the arm64 staging.
[ "${SKIP_ARM:-0}" = 1 ] || rm -rf "$OUT"
mkdir -p "$OUT" "$HERE/logs"
build() { # arch jobs libprefix
  local A=$1 J=$2 FW=$3
  local T=$S/universal-native-build-$A-01
  echo "== $A: cmake re-run with version env and path remapping"
  ( cd "$T" && cmake -S "$SRC" -B "$T" -DCMAKE_C_FLAGS="$PFX" -DCMAKE_CXX_FLAGS="$PFX" -DRSTUDIO_GIT_REVISION_HASH="$COMMIT" -DANT=/opt/homebrew/opt/ant/bin/ant > "$HERE/logs/cmake-$A.log" 2>&1 )
  /usr/bin/grep -q "define RSTUDIO_GIT_COMMIT \"$COMMIT\"" "$T/src/cpp/session/session-config.h" || { echo "commit id missing from session-config.h in $A"; exit 1; }
  /usr/bin/grep -E 'Building RStudio' "$HERE/logs/cmake-$A.log"
  /usr/bin/grep -E 'define RSTUDIO_(VERSION|BUILD_TYPE|RELEASE_NAME)' "$T/src/cpp/session/session-config.h"
  echo "== $A: ninja rsession rpostback diagnostics -j$J"
  ninja -C "$T" -j"$J" rsession rpostback diagnostics > "$HERE/logs/ninja-$A.log" 2>&1 || { tail -30 "$HERE/logs/ninja-$A.log"; exit 1; }
  tail -2 "$HERE/logs/ninja-$A.log"
  mkdir -p "$OUT/$A.tmp"
  cp "$T/src/cpp/session/rsession" "$T/src/cpp/session/postback/rpostback" "$T/src/cpp/diagnostics/diagnostics" "$OUT/$A.tmp/"
  "$SRC/package/osx/scripts/fix-library-paths.sh" "$OUT/$A.tmp" "$FW" '*'
  for f in rsession rpostback diagnostics; do
    install_name_tool -delete_rpath "$S/universal-build-preparation-01/inputs-macos12/libraries/$A/lib" "$OUT/$A.tmp/$f" 2>/dev/null || true
  done
}
[ "${SKIP_ARM:-0}" = 1 ] || build arm64 4 "@loader_path/../Frameworks/arm64"
build x86_64 3 "@loader_path/../Frameworks"
cp "$OUT/arm64.tmp/rsession" "$OUT/rsession-arm64"
cp "$OUT/x86_64.tmp/rsession" "$OUT/rsession"
for f in rpostback diagnostics; do lipo -create "$OUT/x86_64.tmp/$f" "$OUT/arm64.tmp/$f" -output "$OUT/$f"; done
rm -rf "$OUT/arm64.tmp" "$OUT/x86_64.tmp"
for f in rsession-arm64 rsession rpostback diagnostics; do
  echo "== $f"; file "$OUT/$f" | cut -c1-90; otool -L "$OUT/$f" | sed -n '2,6p'
  echo "rpaths: $(otool -l "$OUT/$f" | /usr/bin/grep -c LC_RPATH || true)  personal-path strings: $(strings -a "$OUT/$f" | /usr/bin/grep -cF -e "$S" -e /Users/ || true)"
  strings -a "$OUT/$f" | /usr/bin/grep -E '^(0\.1\.[0-9]+|2026\.10\.999.*|Beta|RAI-Studio)$' | sort | uniq -c
done
