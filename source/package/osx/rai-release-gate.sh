#!/bin/bash
# rai-release-gate.sh -- fail-closed gate for every RAI-Studio remote write.
#
# Why: v0.1.56 was published while a user release hold was being placed. The old
# hold was a one-time file check at publish-phase entry of a version-specific
# script; the hold file appeared ~15 s after that check passed and the in-flight
# chain went on to push the tag and create the release. Nothing tied the artifact
# to the CURRENT user requirements.
#
# Contract: call this IMMEDIATELY before each remote write (tag push, release
# create, asset upload, PR merge) -- not once per phase:
#
#   rai-release-gate.sh check <stage-dir> <version> <source-commit>
#
# It refuses (exit 1) when:
#   * any <stage-dir>/USER-RELEASE-HOLD*.md exists (a hold is never lifted by
#     a script; the owner removes/renames it after the requirement is verified);
#   * <stage-dir>/RELEASE-REQUIREMENTS.sha256 is missing, or no longer matches
#     the sha256 of the current requirement contracts (<stage-dir>/USER-*.md
#     excluding holds) -- i.e. requirements changed after acceptance;
#   * <stage-dir>/release-acceptance-<version>.txt is missing or does not name
#     exactly this version, this source commit and the same requirements digest,
#     with ACCEPTANCE=GREEN;
#   * the version is already published (immutable releases; bump instead), or
#     the remote cannot be read: only "release not found" / HTTP 404 from
#     `gh release view` counts as unpublished, so a missing or logged-out gh,
#     a network error or a rate limit blocks too.
#
#   rai-release-gate.sh digest <stage-dir>
# prints the current requirements digest (for writing acceptance receipts).
#
# Environment: RAI_GATE_SKIP_REMOTE=1 skips the published-version remote read
# (unit tests only). The gate never writes remotely.
set -euo pipefail

die() { printf 'RELEASE GATE BLOCKED: %s\n' "$*" >&2; exit 1; }

requirements_digest() {
  local stage=$1 files=()
  local f
  while IFS= read -r f; do files+=("$f"); done < <(
    find "$stage" -maxdepth 1 -type f -name 'USER-*.md' ! -name 'USER-RELEASE-HOLD*' | LC_ALL=C sort)
  [ "${#files[@]}" -gt 0 ] || die "no USER-*.md requirement contracts in $stage"
  for f in "${files[@]}"; do
    printf '%s  %s\n' "$(shasum -a 256 "$f" | cut -d' ' -f1)" "$(basename "$f")"
  done | shasum -a 256 | cut -d' ' -f1
}

# Prints "published" or "unpublished". Only a "release not found" or HTTP 404
# answer means unpublished; gh missing, logged out, offline or rate limited dies.
remote_tag_state() {
  local tag=$1 err rc=0
  command -v gh >/dev/null 2>&1 || die "gh not found; cannot confirm $tag is unpublished"
  err=$(gh release view "$tag" -R NamStacks/RAI-Studio 2>&1 >/dev/null) || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo published
    return
  fi
  case "$err" in
    *"release not found"*|*"HTTP 404"*|*"status code: 404"*) echo unpublished ;;
    *) die "cannot confirm $tag is unpublished: gh release view failed (exit $rc): ${err:-no output}" ;;
  esac
}

cmd=${1:-}
case "$cmd" in
  digest)
    [ $# -eq 2 ] || die "usage: $0 digest <stage-dir>"
    requirements_digest "$2" ;;
  check)
    [ $# -eq 4 ] || die "usage: $0 check <stage-dir> <version> <source-commit>"
    stage=$2 version=$3 commit=$4
    [ -d "$stage" ] || die "stage dir missing: $stage"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid version: $version"
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "source commit must be a full sha: $commit"

    shopt -s nullglob
    holds=("$stage"/USER-RELEASE-HOLD*.md)
    shopt -u nullglob
    [ "${#holds[@]}" -eq 0 ] || die "active user hold: ${holds[*]}"

    current=$(requirements_digest "$stage")
    pinned_file=$stage/RELEASE-REQUIREMENTS.sha256
    [ -f "$pinned_file" ] || die "requirements not pinned ($pinned_file missing)"
    pinned=$(tr -d '[:space:]' < "$pinned_file")
    [ "$pinned" = "$current" ] || die "requirements changed since acceptance (pinned $pinned, current $current)"

    receipt=$stage/release-acceptance-$version.txt
    [ -f "$receipt" ] || die "acceptance receipt missing: $receipt"
    grep -qx "VERSION=$version" "$receipt" || die "receipt version mismatch"
    grep -qx "SOURCE_COMMIT=$commit" "$receipt" || die "receipt source commit mismatch"
    grep -qx "REQUIREMENTS_SHA256=$current" "$receipt" || die "receipt requirements digest mismatch"
    grep -qx "ACCEPTANCE=GREEN" "$receipt" || die "receipt is not ACCEPTANCE=GREEN"

    if [ "${RAI_GATE_SKIP_REMOTE:-0}" != 1 ]; then
      for tag in "v$version-beta" "v$version"; do
        state=$(remote_tag_state "$tag") || exit 1
        [ "$state" = unpublished ] || die "$tag is already published; releases are immutable, bump the version"
      done
    fi
    printf 'RELEASE GATE OK version=%s commit=%s requirements=%s\n' "$version" "$commit" "$current" ;;
  *)
    die "usage: $0 check <stage-dir> <version> <source-commit> | digest <stage-dir>" ;;
esac
