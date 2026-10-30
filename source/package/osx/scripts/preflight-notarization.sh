#!/usr/bin/env bash
#
# preflight-notarization.sh
#
# Fails loudly, before anyone uploads to Apple, if any embedded Mach-O in
# RAI-Studio.app would trigger the notarization errors seen on submission
# bff0ce43 (0.1.13): "not signed with a valid Developer ID certificate"
# and "signature does not include a secure timestamp".
#
# For every Mach-O (excluding symlinks) it requires:
#   - a valid, strict signature (codesign --verify --strict),
#   - a Developer ID Application authority (not ad-hoc),
#   - the hardened runtime flag,
#   - a secure timestamp, and
#   - no com.apple.security.get-task-allow entitlement (Apple rejects it
#     for Developer ID distribution).
# It also verifies the outer app seals cleanly (--deep --strict).
#
# Exit status is non-zero if anything is wrong, so it can gate the
# notarytool submission step. It reads no credentials and submits nothing.
#
# This program is licensed under version 3 of the GNU Affero General
# Public License, distributed WITHOUT ANY EXPRESS OR IMPLIED WARRANTY.
# See http://www.gnu.org/licenses/agpl-3.0.txt for details.
#
# Usage: preflight-notarization.sh /path/to/RAI-Studio.app

set -uo pipefail

APP="${1:-}"
if [ -z "${APP}" ] || [ ! -d "${APP}" ]; then
   echo "Usage: preflight-notarization.sh <path-to-.app>" >&2
   exit 1
fi
APP="$(cd "${APP}" && pwd)"

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

checked=0
failed=0

check_one() {
   local f="${1}" info flags problems=""
   info="$(codesign -dvvv --verbose=4 "${f}" 2>&1 || true)"

   if ! codesign --verify --strict "${f}" >/dev/null 2>&1; then
      problems="${problems}invalid-signature "
   fi

   if ! printf '%s\n' "${info}" | grep -q '^Authority=Developer ID Application'; then
      problems="${problems}no-developer-id "
   fi

   # Confirm the signature actually chains to Apple's Developer ID CA, so a
   # self-signed cert whose common name merely starts with "Developer ID
   # Application" cannot pass this gate.
   if ! printf '%s\n' "${info}" | grep -q '^Authority=Developer ID Certification Authority'; then
      problems="${problems}no-devid-intermediate "
   fi
   if ! printf '%s\n' "${info}" | grep -q '^Authority=Apple Root CA'; then
      problems="${problems}no-apple-root "
   fi

   flags="$(printf '%s\n' "${info}" | grep -oE 'flags=0x[0-9a-fA-F]+\([^)]*\)' | head -1)"
   case "${flags}" in
      *adhoc*) problems="${problems}adhoc " ;;
   esac
   case "${flags}" in
      *runtime*) : ;;
      *) problems="${problems}no-hardened-runtime " ;;
   esac

   if ! printf '%s\n' "${info}" | grep -q '^Timestamp='; then
      problems="${problems}no-secure-timestamp "
   fi

   if codesign -d --entitlements - "${f}" 2>/dev/null | grep -q 'get-task-allow'; then
      problems="${problems}has-get-task-allow "
   fi

   if [ -n "${problems}" ]; then
      printf '  [FAIL] %-45s %s\n' "${problems% }" "${f#"${APP}"/}"
      return 1
   fi
   return 0
}

echo "[i] Preflight: ${APP}"
echo "[i] Checking every embedded Mach-O for Developer ID + hardened runtime + secure timestamp"

while IFS= read -r f; do
   [ -n "${f}" ] || continue
   is_macho "${f}" || continue
   checked=$((checked + 1))
   if ! check_one "${f}"; then
      failed=$((failed + 1))
   fi
done < <(find "${APP}" -type f -not -type l -print)

# A run that scanned nothing means the app path was wrong or files could
# not be read; that must never read as a pass.
if [ "${checked}" -eq 0 ]; then
   echo "  [FAIL] no Mach-O files were scanned (bad app path or unreadable files)"
   failed=$((failed + 1))
fi

echo "[i] Verifying outer bundle seal (codesign --verify --deep --strict)"
seal_ok=1
if ! codesign --verify --deep --strict --verbose=2 "${APP}" >/dev/null 2>&1; then
   echo "  [FAIL] outer bundle failed --deep --strict verification"
   seal_ok=0
fi

echo "[i] Checked ${checked} Mach-O files; ${failed} failed."

if [ "${failed}" -ne 0 ] || [ "${seal_ok}" -ne 1 ]; then
   echo "[!] PREFLIGHT FAILED. Do not submit this app for notarization." >&2
   exit 1
fi

echo "[i] PREFLIGHT PASSED. Every Mach-O carries Developer ID + hardened runtime + secure timestamp."
echo "[i] This does not submit or staple; run the notarytool gate separately."
