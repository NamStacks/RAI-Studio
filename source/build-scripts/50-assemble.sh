#!/bin/bash
# Assemble the 0.1.62 app as a patched APFS clone of the stapled release-11 app. Files only; no signing here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S=${STAGE:?set STAGE to the build staging folder}
SRC=$S/universal-build-preparation-01/builder-source-49a8
BRIDGE=$S/universal-bridge-producer-01/bridge-source
BASE=$S/universal-release-11/stapled/RAI-Studio.app
W=$S/beta2-work
OUT=$W/assembly
NATIVE=$W/native-out
GWT=$S/universal-native-build-x86_64-01/gwt
ELECTRON=$W/etree/src/node/desktop-0162/out/RAI-Studio-darwin-arm64/RAI-Studio.app/Contents
APP=$OUT/RAI-Studio.app
A=$APP/Contents/Resources/app
VERSION=0.1.62

for p in "$NATIVE/rsession" "$NATIVE/rsession-arm64" "$NATIVE/rpostback" "$NATIVE/diagnostics" "$GWT/www/index.htm" "$ELECTRON/Info.plist"; do
  [ -e "$p" ] || { echo "missing input: $p"; exit 1; }
done

rm -rf "$OUT" && mkdir -p "$OUT"
cp -c -R "$BASE" "$APP"
chmod -R u+w "$APP"
# The stapled ticket belongs to the old signature.
rm -f "$APP/Contents/CodeResources"

echo "== native binaries"
for f in rsession rsession-arm64 rpostback diagnostics; do cp "$NATIVE/$f" "$A/bin/$f"; done

echo "== R files"
cp "$SRC/src/cpp/r/R/Tools.R" "$A/R/Tools.R"
for f in "$A"/R/modules/*.R; do
  n=$(basename "$f")
  if [ -f "$SRC/src/cpp/session/modules/$n" ] && ! cmp -s "$SRC/src/cpp/session/modules/$n" "$f"; then
    echo "  module updated: $n"; cp "$SRC/src/cpp/session/modules/$n" "$f"
  fi
done

echo "== session resources (files the source tree changed)"
git -C "$SRC" status --short -- src/cpp/session/resources | while read -r st path; do
  rel=${path#src/cpp/session/resources/}
  case "$st" in
    D) rm -f "$A/resources/$rel"; echo "  removed $rel";;
    *) if [ -e "$A/resources/$rel" ] || [ "$st" = "??" ] || [ "$st" = "A" ]; then
         mkdir -p "$(dirname "$A/resources/$rel")"; cp "$SRC/$path" "$A/resources/$rel"; echo "  updated $rel"
       else echo "  skipped (not shipped) $rel"; fi;;
  esac
done

echo "== top-level documents"
cp "$SRC/README.md" "$A/README.md"
cp "$SRC/INSTALL" "$A/INSTALL"
cp "$SRC/NOTICE" "$A/NOTICE"
cp "$SRC/NOTICE" "$A/resources/NOTICE"
cp "$SRC/SOURCE.in" "$A/SOURCE"
printf '%s\n' "$VERSION" > "$A/VERSION"
cp "$W/../universal-electron-inputs-01/LICENSE" "$APP/Contents/Resources/LICENSE.electron"
cp "$W/../universal-electron-inputs-01/LICENSES.chromium.html" "$APP/Contents/Resources/LICENSES.chromium.html"

echo "== GWT client"
rm -rf "$A/www" && mkdir "$A/www"
rsync -a --exclude .gitignore "$GWT/www/" "$A/www/"
rm -rf "$A/www-symbolmaps" && mkdir "$A/www-symbolmaps"
find "$GWT/extras" -name '*.symbolMap' -exec cp {} "$A/www-symbolmaps/" \;
# Source locations inside the symbol maps are file: URLs under the build tree; keep the path below src/ only.
sed -i '' -E "s#file:/Users/[^,]*/builder-source-49a8/#file:/rstudio/#g" "$A"/www-symbolmaps/*.symbolMap

echo "== Electron bundles"
rsync -rc --exclude native_modules "$ELECTRON/Resources/app/.webpack/" "$A/.webpack/"
cp "$ELECTRON/Resources/app/package.json" "$A/package.json"
for f in "$SRC"/src/node/desktop/resources/icons/*.icns; do
  [ -e "$APP/Contents/Resources/$(basename "$f")" ] && cp "$f" "$APP/Contents/Resources/$(basename "$f")"
done
# Keep the universal native modules from release-11; strip the debug-map entries that name the build tree.
find "$A/.webpack/main/native_modules" -name "*.node" -exec strip -S {} + 2>/dev/null

echo "== Info.plist"
P=$APP/Contents/Info.plist
pb() { /usr/libexec/PlistBuddy -c "Set :$1 $2" "$P"; }
for k in CFBundleShortVersionString CFBundleVersion CFBundleLongVersionString; do pb $k "$VERSION"; done
pb CFBundleGetInfoString "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleGetInfoString' "$ELECTRON/Info.plist")"
pb NSHumanReadableCopyright "$(/usr/libexec/PlistBuddy -c 'Print :NSHumanReadableCopyright' "$ELECTRON/Info.plist")"
pb NSMicrophoneUsageDescription "$(/usr/libexec/PlistBuddy -c 'Print :NSMicrophoneUsageDescription' "$ELECTRON/Info.plist")"
for H in "$APP"/Contents/Frameworks/RAI-Studio\ Helper*.app; do
  for k in CFBundleShortVersionString CFBundleVersion; do /usr/libexec/PlistBuddy -c "Set :$k $VERSION" "$H/Contents/Info.plist"; done
done

echo "== bridge"
rsync -rcm --existing --exclude node_modules "$BRIDGE/" "$A/rai-chat-bridge/"
rm -f "$A/rai-chat-bridge/skills/rai-audit/PROVENANCE.md"
# --existing still creates the bridge repo and test folders as empty directories.
find "$A/rai-chat-bridge" -mindepth 1 -type d -empty -not -path '*/node_modules/*' -delete

echo "== bundle hygiene"
find "$A/bin" -name __pycache__ -type d -prune -exec rm -rf {} +
# Windows-only pieces of node-pty and a proprietary language server are not part of the beta bundle.
rm -rf "$A/copilot-language-server-js"
rm -f "$A/resources/pdfjs/web/viewer.css-e"
find "$A/rai-chat-bridge/node_modules" \( -path '*/node-pty/third_party/conpty' -o -path '*/node-pty/deps' -o -path '*/node-pty/prebuilds/win32-*' \) -prune -exec rm -rf {} + 2>/dev/null || true

echo "assembled: $APP"
