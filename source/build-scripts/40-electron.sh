#!/bin/bash
# Build the Electron main/renderer bundles for 0.1.62 offline, in an APFS clone of the old build dir (it holds node_modules).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/plan-env-0162.sh"
S=${STAGE:?set STAGE to the build staging folder}
B=$S/universal-build-preparation-01/builder-source-49a8/src/node
SRC=$S/universal-build-preparation-01/builder-source-49a8
T=$S/beta2-work/etree
W=$T/src/node/desktop-0162
export PATH="$S/source/dependencies/common/node/22.22.2/bin:$PATH"
node --version
/usr/bin/grep -E "RSTUDIO_VERSION: |RSTUDIO_RELEASE_NAME" "$B/desktop-build-arm64/src/main/build-info.ts"
/usr/bin/grep -E '"version"|"productName"' "$B/desktop-build-arm64/package.json"
# The bundle resolves ../../../../../cpp/session/resources from its own path, so the clone sits in a tree that has src/cpp.
rm -rf "$T" && mkdir -p "$T/src/node" && ln -s "$SRC/src/cpp" "$T/src/cpp"
cp -c -R "$S/source/src/node/desktop-build-arm64" "$W"
rm -rf "$W/out" "$W/.webpack"
rsync -a --exclude node_modules --exclude out --exclude .webpack --exclude build --exclude bin --exclude src/native --exclude src/types "$B/desktop-build-arm64/" "$W/"
cd "$W"
export npm_config_arch=arm64 npm_config_target_arch=arm64 npm_config_offline=true
./node_modules/.bin/electron-forge package --arch=arm64 --platform=darwin > "$HERE/logs/electron.log" 2>&1 || { tail -40 "$HERE/logs/electron.log"; exit 1; }
tail -5 "$HERE/logs/electron.log"
ls "$W/out"
/usr/bin/grep -E '"version"|"productName"' "$W/out/"*/RAI-Studio.app/Contents/Resources/app/package.json
