# RAI-Studio release checklist

Follow this for every external macOS release. Do not skip a step, and do not publish when a hard stop below is not met.

## Naming

The dev build is the numeric version, for example `0.1.63`. Every beta release uses the same three names:

- Tag: `v<dev build>-beta` (for example `v0.1.63-beta`)
- Release title: `RAI-Studio <dev build> Beta`
- DMG file: `RAI-Studio-<dev build>-beta-universal.dmg`

`version/BUILDTYPE` is `Beta`. The numeric version comes from `RSTUDIO_VERSION_MAJOR`, `RSTUDIO_VERSION_MINOR`, `RSTUDIO_VERSION_PATCH` and `RSTUDIO_VERSION_SUFFIX` in the build environment.

## Required order

1. Confirm the worktree is clean and the release commit is the one you tested.
2. Update the source locator to the new tag in `SOURCE.in`, the `NOTICE` header and `README.md`. The folder is `source/`, for example `https://github.com/NamStacks/RAI-Studio/tree/v0.1.63-beta/source`. Confirm the tag and folder exist and hold the complete corresponding source, including the RAI Assistant bridge. Build the folder with the export steps below.
3. Run the tests:
   - Bridge: `node --test test/*.test.js` in the `rai-chat-bridge` checkout.
   - Desktop: `npm test` in `src/node/desktop`.
   - R side of the Assistant: the testthat files under `src/cpp/tests/testthat`, including `test-chat-guardrails.R`.
   - Packaging: the scripts in `package/osx/test`, and `package/osx/test-rai-release-gate.sh`.
4. Build the universal app (see Build below). The output is `RAI-Studio.app`.
5. Sign nested code leaf-first and sign the outer app last (see Signing below). Keep the Electron JIT and executable-memory entitlements and the `rsession` DYLD entitlement. Then run the branding and trace gate below on the signed app.
6. Check the voice entitlement on the signed app: `codesign -d --entitlements - RAI-Studio.app` must list `com.apple.security.device.audio-input`. Without it, voice input in the Assistant terminal is denied silently.
7. Launch the exact signed app. Confirm its shell and `rsession` stay alive, then run a minimal R evaluation. Confirm there is no network traffic to Posit hosts at startup.
8. Check the RAI Assistant:
   - Settings shows the four providers: Claude Code, Codex, OpenCode and Grok Build.
   - The provider you pick persists after a restart.
   - Each provider signs in through its own command line tool, with the user's own subscription sign-in.
   - No approval cards appear.
   - Voice input in the Assistant terminal asks for microphone permission and works.
9. Create a DMG that holds `RAI-Studio.app` and an Applications link, named as above.
10. Submit the final DMG once through a local Keychain `notarytool` profile (`docker/jenkins/notarize-release.sh`, or `60-release.sh` on the patched route). Set the profile label with `NOTARY_PROFILE`. The label is machine-local and is not a product name. Require `Accepted`.
11. Staple and validate. Mount the DMG and require mounted-app Gatekeeper acceptance as `Notarized Developer ID`.
12. Tag and publish only the tested commit. Run the release gate (see Release gate below) immediately before the tag push, again before `gh release create`, and again before each asset upload. Re-fetch the GitHub release metadata and confirm the uploaded DMG filename, size and checksum.

## Signing (step 5)

Two scripts under `package/osx/scripts` do the signing, with the entitlement sets in `package/osx/entitlements` (`rstudio-notarized.plist`, `node-notarized.plist`, `rsession-notarized.plist`):

- `sign-release.sh` signs every embedded Mach-O leaf first (Developer ID, hardened runtime, secure timestamp, per-class entitlements), then the nested frameworks and Electron helper apps, then the outer app last, with no final `--deep` resign. It runs the preflight when it finishes.
- `preflight-notarization.sh` fails, before anyone submits, on any Mach-O that is unsigned, ad-hoc, untimestamped, missing a Developer ID authority or the hardened runtime, or carrying `com.apple.security.get-task-allow`.

Run the signer on the built app before you create the DMG:

    RAI_SIGN_IDENTITY="Developer ID Application: <name> (<TEAMID>)" \
       package/osx/scripts/sign-release.sh \
       package/osx/install/RAI-Studio.app

The identity comes from the environment so it never enters the repository or a build log. `RAI_KEYCHAIN` may point at a specific keychain, and `--dry-run` prints the signing plan without signing anything. Submission and stapling are separate steps (10 and 11). Signing never submits or staples.

## Build (step 4)

The 0.1.63 Beta was not built from scratch. It was produced by patching a signed release app with freshly built `rsession`, `rpostback` and diagnostics tools, the GWT client, the Electron bundles and the changed resources. The scripts are in `source/build-scripts/` and run in this order: `20-native.sh`, `30-gwt.sh`, `40-electron.sh`, `50-assemble.sh` (files only, no signing), then `60-release.sh` (sign, notarize, staple, DMG). Their README describes the staging layout they assume.

The from-scratch route stays `package/osx/make-package` (see `INSTALL`). It does not set the path remapping, so export `-ffile-prefix-map=<source root>=.` and `-ffile-prefix-map=<build root>=.` in `CFLAGS` and `CXXFLAGS` before you run it. `20-native.sh` sets its own remapping. On either route, the trace gate below must find no builder path other than the known strings it lists.

## Release gate (step 12)

`package/osx/rai-release-gate.sh check <stage-dir> <version> <source-commit>` never writes remotely and exits 1 on any failure. It needs, in `<stage-dir>`:

- the `USER-*.md` requirement contracts and `RELEASE-REQUIREMENTS.sha256` holding their digest (`rai-release-gate.sh digest <stage-dir>` prints it);
- `release-acceptance-<version>.txt` with `VERSION=`, `SOURCE_COMMIT=` (the full sha), `REQUIREMENTS_SHA256=` and `ACCEPTANCE=GREEN`;
- no `USER-RELEASE-HOLD*.md` file;
- a working, logged-in `gh`. The gate asks GitHub whether `v<version>-beta` or `v<version>` already exists in `NamStacks/RAI-Studio`. It treats only "release not found" or HTTP 404 as unpublished, so a missing `gh`, a logged-out `gh`, a network error or a rate limit blocks the release.

## Public source export (step 2)

Build the `source/` folder from the release commit with `git archive`, then delete what does not ship. Omit:

- `docs/plans/`, `docs/UPDATES.md` and `docs/rai-*.md` (planning notes)
- `RAI-STUDIO-HANDOFF.md` and `RAI-STUDIO-MACOS-INSTALL.md`
- `package/osx/release-v*.sh`
- `package/osx/RAI-Studio-0.1.55-*`
- every file in `.github/workflows` that names `rstudio/rstudio` or any other org than `NamStacks`. List them, then omit each one or fix it:

      rg --no-ignore --hidden -l -i -P 'rstudio/rstudio|genomerx|github\.com/(?!NamStacks/)[A-Za-z0-9_.-]+/|(?:repository|repos)[:/ ]+(?!NamStacks/)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' .github/workflows

Add what the archive does not hold:

- The bridge lives in a separate repository. Copy its checkout into `source/rai-chat-bridge/` without `node_modules`, `.git` and test output: `rsync -a --exclude node_modules --exclude .git --exclude test-results --exclude coverage <bridge checkout>/ source/rai-chat-bridge/`.
- Copy the build scripts into `source/build-scripts/`, with the build machine's paths and signing identity replaced by variables.

Keep `COPYING`, `NOTICE`, `SOURCE.in`, `INSTALL` and the bridge. Run the trace gate below on the export too.

## Branding and trace gate (after step 5)

Scan the signed `RAI-Studio.app` and the source export. Each hit needs a fix or a written reason before you publish. Every `rg` here passes `--no-ignore --hidden`: by default `rg` skips files that `.gitignore` or hidden-file rules cover, so a staged tree passes with no hits at all.

    for term in '/Users/' 'GenomeRx' 'Posit'; do
       rg --no-ignore --hidden -a -l -i -F "$term" <app or export> ; done

The private checklist adds the build machine's home path, its staging folder names and its private tooling names to this list. Those strings stay out of this repository, except staging folder names inside `build-scripts/`.

- `GenomeRx` may appear only as the bundle id `com.genomerx.rai-studio`.
- `Posit` hits are expected where the app really names Posit: Posit Connect publishing, Posit Assistant (off by default), `posit.co` documentation links, cheat-sheet links and the legal notices. The check is that no Posit support, download or update link is presented as RAI-Studio's own.
- `/Users/` also matches paths that bundled third-party tools carry from their own CI builds. Record those as the reason.
- Read the `Info.plist` strings (`CFBundleName`, `CFBundleDisplayName`, `CFBundleIdentifier`, copyright) and confirm they say RAI-Studio.

Known remaining build-path strings in the app: one SOCI default-backend path in `rsession`, the OpenSSL `OPENSSLDIR` in the bundled `libcrypto`, and Haskell build paths in the bundled `pandoc`. The gate allowlists exactly these files: `bin/rsession`, `bin/rsession-arm64`, `Frameworks/libcrypto.3.dylib`, `Frameworks/arm64/libcrypto.3.dylib` and `quarto/bin/tools/aarch64/pandoc`. A builder path in any other file is a hit to fix.

## Hard stops

Do not publish when any item is missing: a valid Developer ID authority, the required entitlements (including voice), a live app and R-session check, notarization acceptance, stapler validation, mounted-app Gatekeeper acceptance, a passing release gate, or a verified GitHub asset.

Never store notarization credentials, Apple passwords, API keys, tokens or private keys in this repository or in release logs.
