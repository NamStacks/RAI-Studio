#!/bin/bash
# Sign, notarize and staple the assembled app, then build, sign, notarize and staple the DMG. Needs a notarytool Keychain profile and the Developer ID identity in the login keychain.
set -euo pipefail
S=${STAGE:?set STAGE to the build staging folder}
SRC=$S/universal-build-preparation-01/builder-source-49a8
W=$S/beta3-work
ID="${RAI_SIGN_IDENTITY:?set RAI_SIGN_IDENTITY}"
R=$W/release
VERSION=0.1.64
DMG=$R/RAI-Studio-$VERSION-beta-universal.dmg
step() { echo "[$(date +%H:%M:%S)] $*"; }

rm -rf "$R" && mkdir -p "$R/dmgstage"
step "clone assembled app"
cp -c -R "$W/assembly/RAI-Studio.app" "$R/RAI-Studio.app"

step "sign app"
RAI_SIGN_IDENTITY="$ID" bash "$SRC/package/osx/scripts/sign-release.sh" "$R/RAI-Studio.app" > "$R/sign.log" 2>&1 || { tail -30 "$R/sign.log"; exit 1; }
tail -4 "$R/sign.log"

step "zip"
ditto -c -k --keepParent "$R/RAI-Studio.app" "$R/app-notarize.zip"
step "notarize app"
xcrun notarytool submit "$R/app-notarize.zip" --keychain-profile "${NOTARY_PROFILE:?set NOTARY_PROFILE}" --wait > "$R/notary-app.log" 2>&1 || true
tr '\r' '\n' < "$R/notary-app.log" | /usr/bin/grep -E "id:|status:" | tail -3
/usr/bin/grep -q "status: Accepted" "$R/notary-app.log" || { echo "app notarization not accepted"; exit 1; }

step "clone and staple app"
cp -c -R "$R/RAI-Studio.app" "$R/dmgstage/RAI-Studio.app"
xcrun stapler staple "$R/dmgstage/RAI-Studio.app" | tail -2
xcrun stapler validate "$R/dmgstage/RAI-Studio.app" | tail -1
spctl -a -t exec -vv "$R/dmgstage/RAI-Studio.app" 2>&1 | head -3
ln -s /Applications "$R/dmgstage/Applications"

step "hdiutil create"
hdiutil create -volname "RAI-Studio" -srcfolder "$R/dmgstage" -ov -format UDZO "$DMG" > "$R/hdiutil.log" 2>&1
step "sign dmg"
codesign --force --sign "$ID" --timestamp "$DMG"
step "notarize dmg"
xcrun notarytool submit "$DMG" --keychain-profile "${NOTARY_PROFILE:?set NOTARY_PROFILE}" --wait > "$R/notary-dmg.log" 2>&1 || true
tr '\r' '\n' < "$R/notary-dmg.log" | /usr/bin/grep -E "id:|status:" | tail -3
/usr/bin/grep -q "status: Accepted" "$R/notary-dmg.log" || { echo "dmg notarization not accepted"; exit 1; }
step "staple dmg"
xcrun stapler staple "$DMG" | tail -2
xcrun stapler validate "$DMG" | tail -1
spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | head -3
shasum -a 256 "$DMG" | tee "$R/SHA256SUMS-dmg.txt"
ls -l "$DMG"
codesign -dvv "$R/dmgstage/RAI-Studio.app" 2>&1 | /usr/bin/grep -E "CDHash|Authority=Developer|TeamIdentifier"
step "done"
