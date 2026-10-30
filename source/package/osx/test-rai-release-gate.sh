#!/bin/bash
# Deterministic local tests for rai-release-gate.sh (no remote access).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
gate=$here/rai-release-gate.sh
export RAI_GATE_SKIP_REMOTE=1
tmp=$(mktemp -d "${TMPDIR:-/tmp}/rai-gate-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
pass=0 fail=0
C=0123456789abcdef0123456789abcdef01234567

expect() { # expect <ok|block> <name> <pattern-or-empty> -- cmd...
  local want=$1 name=$2 pat=$3; shift 4
  local out rc; out=$("$@" 2>&1); rc=$?
  if { [ "$want" = ok ] && [ $rc -eq 0 ]; } || { [ "$want" = block ] && [ $rc -ne 0 ] && [[ "$out" == *"$pat"* ]]; }; then
    pass=$((pass+1)); echo "ok   $name"
  else
    fail=$((fail+1)); echo "FAIL $name (rc=$rc): $out"
  fi
}

S=$tmp/stage; mkdir -p "$S"
printf 'autonomy contract v1\n' > "$S/USER-AUTO-APPROVAL-SCOPE.md"
printf 'trace contract v1\n' > "$S/USER-DATA-TRACE-CONTRACT.md"
receipt() { printf 'VERSION=%s\nSOURCE_COMMIT=%s\nREQUIREMENTS_SHA256=%s\nACCEPTANCE=%s\n' "$1" "$2" "$3" "$4" > "$S/release-acceptance-$1.txt"; }

expect block "requirements must be pinned" "not pinned" -- "$gate" check "$S" 0.1.57 $C
D=$("$gate" digest "$S"); echo "$D" > "$S/RELEASE-REQUIREMENTS.sha256"
expect block "receipt required" "receipt missing" -- "$gate" check "$S" 0.1.57 $C
receipt 0.1.57 $C "$D" GREEN
expect ok "green receipt for current requirements passes" "" -- "$gate" check "$S" 0.1.57 $C
expect block "different commit refused" "source commit mismatch" -- "$gate" check "$S" 0.1.57 ${C/0/f}
expect block "short sha refused" "full sha" -- "$gate" check "$S" 0.1.57 0123456
expect block "wrong version refused" "receipt missing" -- "$gate" check "$S" 0.1.58 $C

# The v0.1.56 failure mode: a hold placed after an earlier check still blocks
# the NEXT remote write, because the gate re-runs before each write.
printf 'hold\n' > "$S/USER-RELEASE-HOLD-editor-auto.md"
expect block "hold placed mid-chain blocks next write" "active user hold" -- "$gate" check "$S" 0.1.57 $C
rm "$S/USER-RELEASE-HOLD-editor-auto.md"
printf 'hold\n' > "$S/USER-RELEASE-HOLD.md"
expect block "any hold file name blocks" "active user hold" -- "$gate" check "$S" 0.1.57 $C
rm "$S/USER-RELEASE-HOLD.md"
expect ok "hold holds no requirement weight in the digest" "" -- "$gate" check "$S" 0.1.57 $C

printf 'autonomy contract v2 (new requirement)\n' > "$S/USER-AUTO-APPROVAL-SCOPE.md"
expect block "changed requirement invalidates acceptance" "requirements changed" -- "$gate" check "$S" 0.1.57 $C
printf 'new contract\n' > "$S/USER-NEW-REQ.md"
printf 'autonomy contract v1\n' > "$S/USER-AUTO-APPROVAL-SCOPE.md"
expect block "added requirement invalidates acceptance" "requirements changed" -- "$gate" check "$S" 0.1.57 $C
rm "$S/USER-NEW-REQ.md"

receipt 0.1.57 $C "$D" RED
expect block "non-green receipt refused" "not ACCEPTANCE=GREEN" -- "$gate" check "$S" 0.1.57 $C
receipt 0.1.57 $C "0000$D" GREEN
expect block "receipt for other requirements refused" "digest mismatch" -- "$gate" check "$S" 0.1.57 $C

# Remote check, fail closed: only "release not found" or HTTP 404 means unpublished.
receipt 0.1.57 $C "$D" GREEN
fakebin=$tmp/fakebin; mkdir -p "$fakebin"
export GH_LOG=$tmp/gh.log GH_MODE_FILE=$tmp/gh.mode
cat > "$fakebin/gh" <<'GH'
#!/bin/bash
echo "$@" >> "$GH_LOG"
case $(cat "$GH_MODE_FILE") in
  published-beta) [ "$3" = "v0.1.57-beta" ] && exit 0; echo "release not found" >&2; exit 1 ;;
  published-plain) [ "$3" = "v0.1.57" ] && exit 0; echo "release not found" >&2; exit 1 ;;
  notfound) echo "release not found" >&2; exit 1 ;;
  http404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  network) echo "error connecting to api.github.com" >&2; exit 1 ;;
  ratelimit) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;
  loggedout) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 1 ;;
  silent) exit 1 ;;
esac
GH
chmod +x "$fakebin/gh"
remote() { : > "$GH_LOG"; printf '%s\n' "$1" > "$GH_MODE_FILE"; env RAI_GATE_SKIP_REMOTE=0 PATH="$fakebin:$PATH" "$gate" check "$S" 0.1.57 $C; }

expect block "published beta tag is refused" "already published" -- remote published-beta
grep -qx 'release view v0.1.57-beta -R NamStacks/RAI-Studio' "$GH_LOG" && { pass=$((pass+1)); echo "ok   gate queries the -beta tag with -R NamStacks/RAI-Studio"; } || { fail=$((fail+1)); echo "FAIL gate did not query the -beta tag with -R NamStacks/RAI-Studio"; }
expect block "published plain tag is refused" "already published" -- remote published-plain
grep -qx 'release view v0.1.57 -R NamStacks/RAI-Studio' "$GH_LOG" && { pass=$((pass+1)); echo "ok   gate queries the plain tag with -R NamStacks/RAI-Studio"; } || { fail=$((fail+1)); echo "FAIL gate did not query the plain tag with -R NamStacks/RAI-Studio"; }
expect ok "release not found passes the remote check" "" -- remote notfound
[ "$(wc -l < "$GH_LOG" | tr -d ' ')" = 2 ] && { pass=$((pass+1)); echo "ok   unpublished version queries both tags"; } || { fail=$((fail+1)); echo "FAIL unpublished version did not query both tags"; }
expect ok "HTTP 404 passes the remote check" "" -- remote http404
expect block "network error blocks" "cannot confirm" -- remote network
expect block "rate limit blocks" "cannot confirm" -- remote ratelimit
expect block "logged-out gh blocks" "cannot confirm" -- remote loggedout
expect block "silent gh failure blocks" "cannot confirm" -- remote silent

nogh=$tmp/nogh; mkdir -p "$nogh"
for tool in find sort shasum cut tr grep basename; do ln -s "$(command -v "$tool")" "$nogh/$tool"; done
expect block "missing gh blocks" "gh not found" -- env RAI_GATE_SKIP_REMOTE=0 PATH="$nogh" "$gate" check "$S" 0.1.57 $C

echo "gate tests: pass=$pass fail=$fail"
[ $fail -eq 0 ]
