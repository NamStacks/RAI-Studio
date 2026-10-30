#!/usr/bin/env bash
#
# sign-release.sh
#
# Reusable Developer ID release signer for RAI-Studio.app.
#
# The stock codesign-package.sh recursively signs every file under one
# ad-hoc identity with the generic default.plist and finishes with a
# --deep resign. That is fine for local dev builds but Apple's notary
# service rejects it: nested Mach-O end up ad-hoc (no Developer ID
# authority) and without a secure timestamp, and --deep re-signs the
# outer app in a way that does not reliably reach or timestamp every
# leaf. This script signs for real distribution instead:
#
#   1. Every embedded Mach-O leaf (excluding symlinks and bundle main
#      executables) is signed leaf-first with Developer ID + hardened
#      runtime + secure timestamp, with per-class entitlements.
#   2. Nested bundles (frameworks, Electron helper apps) are signed
#      inside-out, then the outer app last. No final --deep resign.
#   3. preflight-notarization.sh verifies the result before anyone
#      submits it.
#
# This program is licensed under version 3 of the GNU Affero General
# Public License. It is distributed WITHOUT ANY EXPRESS OR IMPLIED
# WARRANTY. See http://www.gnu.org/licenses/agpl-3.0.txt for details.
#
# Usage:
#
#    RAI_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" \
#       sign-release.sh /path/to/RAI-Studio.app
#
#    sign-release.sh --dry-run /path/to/RAI-Studio.app
#
# The identity is read from the environment so it never lands in the
# repository or a build log. RAI_KEYCHAIN may point at a specific
# keychain. Never pass an Apple password or notary credential here;
# codesign only needs the code-signing identity.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENT_DIR="$(cd "${SCRIPT_DIR}/../entitlements" && pwd)"

DRY_RUN=0
APP=""

for arg in "$@"; do
   case "${arg}" in
      --dry-run) DRY_RUN=1 ;;
      --help|-h)
         echo "Usage: [RAI_SIGN_IDENTITY=...] sign-release.sh [--dry-run] <path-to-.app>"
         exit 0
         ;;
      -*)
         echo "[!] Unknown option: ${arg}" >&2
         exit 1
         ;;
      *) APP="${arg}" ;;
   esac
done

if [ -z "${APP}" ] || [ ! -d "${APP}" ]; then
   echo "[!] Provide a path to RAI-Studio.app (got: '${APP}')" >&2
   exit 1
fi
APP="$(cd "${APP}" && pwd)"

IDENTITY="${RAI_SIGN_IDENTITY:-}"
KEYCHAIN="${RAI_KEYCHAIN:-}"

# entitlement plists (verified present before we start)
ENT_DEFAULT="${ENT_DIR}/default.plist"
ENT_NODE="${ENT_DIR}/node-notarized.plist"
ENT_RSESSION="${ENT_DIR}/rsession-notarized.plist"
ENT_APP="${ENT_DIR}/rstudio-notarized.plist"
for plist in "${ENT_DEFAULT}" "${ENT_NODE}" "${ENT_RSESSION}" "${ENT_APP}"; do
   if [ ! -f "${plist}" ]; then
      echo "[!] Missing entitlements file: ${plist}" >&2
      exit 1
   fi
done

# --- Mach-O and bundle classification --------------------------------------

# True for a regular Mach-O file (thin or fat). Fat magic (cafebabe) is
# shared with Java class files, so confirm those with file(1).
is_macho() {
   local f="${1}" magic
   magic="$(od -An -N4 -tx1 -- "${f}" 2>/dev/null | tr -d ' \n')"
   case "${magic}" in
      cffaedfe|feedfacf|cefaedfe|feedface) return 0 ;;
      cafebabe|bebafeca|cafebabf|bfbafeca)
         file -b -- "${f}" 2>/dev/null | grep -q 'Mach-O' && return 0
         return 1
         ;;
      *) return 1 ;;
   esac
}

# True for a Mach-O that is the main executable of an enclosing bundle
# (.app/.xpc/.appex/.bundle main, or a .framework main). Those are signed
# when the bundle itself is signed, so they are skipped in the leaf pass.
# A non-main Mach-O that merely happens to live under Contents/MacOS is
# NOT excluded here; it must be signed on its own in the leaf pass.
is_bundle_main() {
   local f="${1}" dir base fwdir fwname bundle main_exe
   case "${f}" in
      */Contents/MacOS/*)
         bundle="${f%/Contents/MacOS/*}"
         base="$(basename "${f}")"
         main_exe="$(plutil -extract CFBundleExecutable raw -o - "${bundle}/Contents/Info.plist" 2>/dev/null || true)"
         if [ -n "${main_exe}" ]; then
            [ "${base}" = "${main_exe}" ] && return 0
            return 1
         fi
         # No Info.plist / key: treat the MacOS entry as the main executable.
         return 0
         ;;
   esac
   dir="$(dirname "${f}")"
   base="$(basename "${f}")"
   case "${dir}" in
      *.framework/Versions/*)
         fwdir="${dir%/Versions/*}"
         fwname="$(basename "${fwdir}")"
         fwname="${fwname%.framework}"
         [ "${base}" = "${fwname}" ] && return 0
         ;;
   esac
   return 1
}

# Entitlements plist for a given leaf, or empty for a plain hardened-runtime
# signature (dylibs and loadable addons carry no meaningful entitlements).
leaf_entitlements() {
   local f="${1}" base
   base="$(basename "${f}")"
   case "${f}" in
      */bin/node/bin/node|*/bin/node-arm64/bin/node)
         printf '%s' "${ENT_NODE}"; return ;;
   esac
   case "${base}" in
      rsession|rsession-arm64)
         printf '%s' "${ENT_RSESSION}"; return ;;
   esac
   case "${f}" in
      */quarto/bin/tools/*)
         case "${f}" in
            *.dylib) printf '' ;;
            *) printf '%s' "${ENT_DEFAULT}" ;;
         esac
         return ;;
   esac
   printf ''
}

# --- signing helpers -------------------------------------------------------

retry() {
   local n=0
   until "$@"; do
      n=$((n + 1))
      if [ "${n}" -ge 3 ]; then
         return 1
      fi
      echo "[i] retrying (${n}/3) after transient failure..." >&2
      sleep 2
   done
}

sign_target() {
   local target="${1}" ent="${2}"
   local args=(--force --sign "${IDENTITY}" --options runtime --timestamp)
   if [ -n "${KEYCHAIN}" ]; then
      args+=(--keychain "${KEYCHAIN}")
   fi
   if [ -n "${ent}" ]; then
      args+=(--entitlements "${ent}")
   fi
   retry codesign "${args[@]}" "${target}"
}

# --- identity check (real signing only) ------------------------------------

if [ "${DRY_RUN}" -eq 0 ]; then
   if [ -z "${IDENTITY}" ]; then
      echo "[!] RAI_SIGN_IDENTITY is required (Developer ID Application identity)." >&2
      echo "    Export it in the shell; do not hard-code it in the repo." >&2
      exit 1
   fi
   find_args=(-v -p codesigning)
   if [ -n "${KEYCHAIN}" ]; then
      find_args+=("${KEYCHAIN}")
   fi
   identities="$(security find-identity "${find_args[@]}" 2>/dev/null || true)"
   if ! printf '%s' "${identities}" | grep -Fq "${IDENTITY}"; then
      echo "[!] Identity not found in the codesigning keychain: ${IDENTITY}" >&2
      echo "    Available Developer ID Application identities:" >&2
      printf '%s\n' "${identities}" | grep 'Developer ID Application' >&2 || echo "    (none)" >&2
      exit 1
   fi
   if ! printf '%s' "${identities}" | grep 'Developer ID Application' | grep -Fq "${IDENTITY}"; then
      echo "[!] '${IDENTITY}' is not a Developer ID Application identity; notarization requires one." >&2
      exit 1
   fi
fi

# --- collect targets -------------------------------------------------------

# Sort helper: deepest path first (leaf-first / inside-out). Bundle and
# leaf paths contain spaces but never newlines or tabs, so an awk depth
# key over a tab separator is safe.
sort_deep() {
   awk -F/ '{ print NF "\t" $0 }' | sort -t "$(printf '\t')" -k1,1nr | cut -f2-
}

echo "[i] App:      ${APP}"
if [ "${DRY_RUN}" -eq 1 ]; then
   echo "[i] Mode:     DRY RUN (no signing)"
else
   echo "[i] Mode:     signing with Developer ID identity"
   echo "[i] Identity: ${IDENTITY}"
fi

if [ "${DRY_RUN}" -eq 0 ]; then
   echo "[i] Removing .DS_Store and stale extended attributes"
   find "${APP}" -name '.DS_Store' -type f -delete 2>/dev/null || true
   xattr -cr "${APP}" 2>/dev/null || true
fi

# leaf pass
leaf_count=0
echo "[i] Signing embedded Mach-O leaves (leaf-first)"
while IFS= read -r f; do
   [ -n "${f}" ] || continue
   is_macho "${f}" || continue
   is_bundle_main "${f}" && continue
   ent="$(leaf_entitlements "${f}")"
   rel="${f#"${APP}"/}"
   if [ "${DRY_RUN}" -eq 1 ]; then
      printf '    leaf  %-28s %s\n' "$(basename "${ent:-<none>}")" "${rel}"
   else
      sign_target "${f}" "${ent}"
   fi
   leaf_count=$((leaf_count + 1))
done < <(find "${APP}" -type f -not -type l -print | sort_deep)

# bundle pass (frameworks + helper apps deepest-first, outer app last)
bundle_count=0
echo "[i] Signing nested bundles, then the outer app (no --deep)"
while IFS= read -r b; do
   [ -n "${b}" ] || continue
   case "${b}" in
      *.app) ent="${ENT_APP}" ;;
      *.framework) ent="" ;;
      *) ent="" ;;
   esac
   rel="${b#"${APP}"/}"
   [ -z "${rel}" ] && rel="$(basename "${b}")"
   if [ "${DRY_RUN}" -eq 1 ]; then
      printf '    bndl  %-28s %s\n' "$(basename "${ent:-<none>}")" "${rel}"
   else
      sign_target "${b}" "${ent}"
   fi
   bundle_count=$((bundle_count + 1))
done < <(find "${APP}" -type d \( -name '*.app' -o -name '*.framework' -o -name '*.bundle' -o -name '*.xpc' -o -name '*.appex' \) -print | sort_deep)

echo "[i] Signed ${leaf_count} leaves and ${bundle_count} bundles"

if [ "${DRY_RUN}" -eq 1 ]; then
   echo "[i] Dry run complete; nothing was signed."
   exit 0
fi

echo "[i] Validating outer signature (codesign --verify --deep --strict)"
codesign --verify --deep --strict --verbose=2 "${APP}"

echo "[i] Running notarization preflight"
"${SCRIPT_DIR}/preflight-notarization.sh" "${APP}"

echo "[i] Done. ${APP} is signed and passed preflight. It has NOT been submitted or stapled."
