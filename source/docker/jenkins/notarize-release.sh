#!/usr/bin/env bash
#
# RStudio Release Notarization (notarize-release.sh)
#
# Copyright (C) 2022 by Posit Software, PBC
#
# Unless you have received this program directly from Posit Software pursuant
# to the terms of a commercial license agreement with Posit Software, then
# this program is licensed to you under the terms of version 3 of the
# GNU Affero General Public License. This program is distributed WITHOUT
# ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
# MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
# AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
#
# Notarizes an RStudio release using a local Keychain notarytool profile.
#
# Usage:
#
#    NOTARY_PROFILE=<local-profile-label> notarize-release.sh [path-to-dmg]
#
# The profile label is machine-local, not product branding. It must have been
# created with `xcrun notarytool store-credentials` on the release Mac. Never
# pass Apple credentials through environment variables or CI logs.

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
    echo "Usage: NOTARY_PROFILE=<local-profile-label> notarize-release.sh [path-to-dmg]" >&2
    exit 1
fi

if [[ -z "${NOTARY_PROFILE:-}" ]]; then
    echo "NOTARY_PROFILE is required. Create or restore its local Keychain profile with xcrun notarytool store-credentials." >&2
    exit 1
fi

# The login keychain can be momentarily unavailable after wake/unlock. Retry the
# non-mutating probe once before declaring a release blocked; credentials remain
# local and are never copied into the repository or CI.
profile_available=false
for attempt in 1 2; do
    if xcrun notarytool history --keychain-profile "${NOTARY_PROFILE}" --output-format json >/dev/null; then
        profile_available=true
        break
    fi
    if [[ "${attempt}" == "1" ]]; then
        sleep 2
    fi
done
if [[ "${profile_available}" != "true" ]]; then
    echo "Keychain notary profile '${NOTARY_PROFILE}' is unavailable after two probes. Restore or unlock the existing local profile; do not add credentials to this repository or CI." >&2
    exit 1
fi

result=$(xcrun notarytool submit "$1" --wait --keychain-profile "${NOTARY_PROFILE}" --output-format json)
status=$(printf '%s' "${result}" | plutil -extract status raw -)
submission_id=$(printf '%s' "${result}" | plutil -extract id raw -)

if [[ "${status}" != "Accepted" ]]; then
    echo "Notarization ${status:-failed}. Submission: ${submission_id:-unknown}" >&2
    if [[ -n "${submission_id:-}" ]]; then
        xcrun notarytool log "${submission_id}" --keychain-profile "${NOTARY_PROFILE}"
    fi
    exit 1
fi

xcrun stapler staple "$1"
xcrun stapler validate "$1"
echo "Notarization accepted and stapled. Submission: ${submission_id}"
