#!/usr/bin/env bash
# Regression fixtures for release-order-gate.mjs. Each fixture runs the real
# gate in a scratch checkout holding this repo's release-please-config.json, an
# SDK that depends on both cores as workspace:*, and both cores at a version.
# gh is a stub: it serves the open pull requests of each branch and main's
# .release-please-manifest.json from files, or fails, stalls or answers
# garbage when told to. With GH_STUB_MERGE_AFTER=k it serves the fixture's
# "after" state from its (k+1)th call on: a release merging mid-run. Every `bad` fixture must exit with the given code and
# exactly the given number of ::error lines, each holding the given text.
# Every `good` fixture must exit 0. Add the shape here when you close a hole.
#
#   bash .github/scripts/release-order-gate-selftest.sh   (needs node, jq)
set -u
cd "$(dirname "$0")/../.." || exit 1
root=$PWD
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fail=0

mkdir -p "$tmp/bin" "$tmp/work/packages/cachekit" "$tmp/work/packages/cachekit-core-ts" "$tmp/work/packages/cachekit-core-wasm"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
# gh api [-H <header>] repos/<repo>/pulls?state=open&head=<owner>:<branch>&per_page=100
# gh api -H <header> repos/<repo>/contents/.release-please-manifest.json?ref=main
[ -z "${GH_STUB_FAIL:-}" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
[ -z "${GH_STUB_SLEEP:-}" ] || exec sleep "$GH_STUB_SLEEP" # the timeout kills sleep itself
[ -z "${GH_STUB_RAW:-}" ] || { printf '%s\n' "$GH_STUB_RAW"; exit 0; }
url=${*: -1}
state=$GH_STUB_STATE
if [ -n "${GH_STUB_MERGE_AFTER:-}" ]; then
  calls=$(($(cat "$GH_STUB_STATE/calls" 2>/dev/null || echo 0) + 1))
  echo "$calls" > "$GH_STUB_STATE/calls"
  [ "$calls" -le "$GH_STUB_MERGE_AFTER" ] || state=$GH_STUB_STATE/after
fi
case $url in
  */contents/.release-please-manifest.json\?ref=main)
    [ -z "${GH_STUB_MANIFEST_RAW:-}" ] || { printf '%s\n' "$GH_STUB_MANIFEST_RAW"; exit 0; }
    cat "$state/manifest"
    ;;
  */pulls\?*)
    branch=${url#*head=*:}
    branch=${branch%%&*}
    cat "$state/open/$branch" 2>/dev/null || echo '[]'
    ;;
  *) echo "gh stub: unexpected $url" >&2; exit 1 ;;
esac
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=cachekit-io/cachekit-ts
cp "$root/release-please-config.json" "$tmp/work/" || exit 1
sdk='{"name":"@cachekit-io/cachekit","version":"0.2.2","dependencies":{"@cachekit-io/cachekit-core-ts":"workspace:*","@cachekit-io/cachekit-core-wasm":"workspace:*","@msgpack/msgpack":"^3.1.3"}}'

n=0
# fixture <ts> <wasm> <main-ts> <main-wasm> [component repo]...: the checkout pins
# core-ts@<ts> and core-wasm@<wasm>, main's manifest records <main-ts> and
# <main-wasm>, and each named component's release branch has an open PR from repo.
fixture() {
  n=$((n + 1))
  state=$tmp/state.$n
  printf '%s\n' "$sdk" > "$tmp/work/packages/cachekit/package.json" || exit 1
  printf '{"name":"@cachekit-io/cachekit-core-ts","version":"%s"}\n' "$1" > "$tmp/work/packages/cachekit-core-ts/package.json"
  printf '{"name":"@cachekit-io/cachekit-core-wasm","version":"%s"}\n' "$2" > "$tmp/work/packages/cachekit-core-wasm/package.json"
  shift 2
  write_state "$state" "$@"
}
# after <main-ts> <main-wasm> [component repo]...: the fixture's state once a release has merged.
after() { write_state "$state/after" "$@"; }
write_state() { # dir main-ts main-wasm [component repo]...
  local dir=$1
  mkdir -p "$dir/open" || exit 1
  jq -n --arg ts "$2" --arg wasm "$3" \
    '{"packages/cachekit": "0.2.1", "packages/cachekit-core-ts": $ts, "packages/cachekit-core-wasm": $wasm}' > "$dir/manifest" || exit 1
  shift 3
  while [ "$#" -ge 2 ]; do
    branch=release-please--branches--main--components--$1
    jq -n --arg b "$branch" --arg r "$2" --arg c "$1" \
      '[{html_url: "https://github.com/\($r)/pull/1", title: "chore(main): release \($c) 9.9.9", head: {ref: $b, repo: {full_name: $r}}}]' \
      > "$dir/open/$branch" || exit 1
    shift 2
  done
}
run() { # kind name code errors text gate-args [env...]
  local kind=$1 name=$2 code=$3 errors=$4 text=$5 gate_args=$6 out rc got
  shift 6
  # shellcheck disable=SC2086 # gate_args is a word list
  out=$(cd "$tmp/work" && env GH_STUB_STATE="$state" "$@" node "$root/.github/scripts/release-order-gate.mjs" $gate_args 2>&1)
  rc=$?
  got=$(grep -c '^::error' <<<"$out")
  case "$kind" in
    bad) [ "$rc" -eq "$code" ] && [ "$got" -eq "$errors" ] && ! grep '^::error' <<<"$out" | grep -qvF -- "$text" && return 0 ;;
    good) [ "$rc" -eq 0 ] && [ "$got" -eq 0 ] && return 0 ;;
  esac
  printf '::error::selftest %s %s: exit %s, %s error lines, expected exit %s, %s holding "%s"\n%s\n' \
    "$kind" "$name" "$rc" "$got" "$code" "$errors" "$text" "$out"
  fail=1
}
pr=packages/cachekit packing='packages/cachekit --packing'
bad() { run bad "$@"; }
good() { run good "$1" 0 0 '' "${@:2}"; }

us=cachekit-io/cachekit-ts
held='has an open release PR'
behind='but main has released'
# --- an open core release PR refuses the SDK, on the PR and when packing ------
fixture 0.2.0 0.2.0 0.2.0 0.2.0 cachekit-core-ts "$us"
bad core-ts 1 1 "@cachekit-io/cachekit-core-ts $held" "$pr"
fixture 0.2.0 0.2.0 0.2.0 0.2.0 cachekit-core-wasm "$us"
bad core-wasm 1 1 "@cachekit-io/cachekit-core-wasm $held" "$packing"
# main at 1dc06f9: both cores' release PRs open.
fixture 0.2.0 0.2.0 0.2.0 0.2.0 cachekit-core-ts "$us" cachekit-core-wasm "$us"
bad both 1 2 "$held" "$pr"
bad both-packing 1 2 "$held" "$packing"
# --- packing an older core than main has released refuses ---------------------
# A refused SDK tag re-run after core-ts released 0.2.1: no PR is open any
# more, but the tag still pins 0.2.0.
fixture 0.2.0 0.2.0 0.2.1 0.2.0
bad rerun-after-release 1 1 "would pin @cachekit-io/cachekit-core-ts@0.2.0, but main has released @cachekit-io/cachekit-core-ts@0.2.1" "$packing"
fixture 0.2.0 0.2.0 0.2.1 0.2.1
bad rerun-both-released 1 2 "$behind" "$packing"
# On the release PR, the merge commit is not what gets packed, so its pins are not checked.
good stale-merge-commit "$pr"
# core-ts's release merges while the gate runs, after k of its three gh calls
# (core-ts PRs, core-wasm PRs, manifest), for every k. Before: its PR is open
# and main records 0.2.0. After: no PR, and main records 0.2.1. Each state
# alone refuses the 0.2.0 pin, so every interleaving must too.
fixture 0.2.0 0.2.0 0.2.0 0.2.0 cachekit-core-ts "$us"
after 0.2.1 0.2.0
bad merge-after-0-calls 1 1 "cachekit-core-ts@0.2.0, but main has released" "$packing" GH_STUB_MERGE_AFTER=0
rm -f "$state/calls"
bad merge-after-1-call 1 2 "cachekit-core-ts" "$packing" GH_STUB_MERGE_AFTER=1
rm -f "$state/calls"
bad merge-after-2-calls 1 2 "cachekit-core-ts" "$packing" GH_STUB_MERGE_AFTER=2
rm -f "$state/calls"
bad merge-after-3-calls 1 1 "@cachekit-io/cachekit-core-ts $held" "$packing" GH_STUB_MERGE_AFTER=3
# --- nothing waiting lets the SDK through -------------------------------------
# main at d400cfd: no release PR open, both cores pinned as released.
fixture 0.2.0 0.2.0 0.2.0 0.2.0
good none "$pr"
good none-packing "$packing"
# A force_release from main once the cores published: pins and manifest agree.
fixture 0.2.1 0.2.1 0.2.1 0.2.1
good force-release-after "$packing"
# The SDK's own release PR is the one being checked, not a hold.
fixture 0.2.0 0.2.0 0.2.0 0.2.0 cachekit "$us"
good sdk-own "$packing"
# A fork's branch of the same name, should the server's head filter let it by.
fixture 0.2.0 0.2.0 0.2.0 0.2.0 cachekit-core-ts someone/cachekit-ts
good fork "$pr"
# A PR whose fork was deleted (head.repo null) is not ours either.
good deleted-fork "$pr" GH_STUB_RAW='[{"head":{"ref":"release-please--branches--main--components--cachekit-core-ts","repo":null}}]'
# --- anything unreadable refuses ----------------------------------------------
cannot='Cannot check release order'
fixture 0.2.0 0.2.0 0.2.0 0.2.0
bad api-down 2 1 "$cannot: gh api" "$pr" GH_STUB_FAIL=1
bad api-down-packing 2 1 "$cannot: gh api" "$packing" GH_STUB_FAIL=1
bad api-stalls 2 1 "timed out after 500 ms" "$packing" GH_STUB_SLEEP=5 RELEASE_ORDER_GATE_TIMEOUT_MS=500
bad not-json 2 1 "$cannot: the open pull requests from release-please--branches--main--components--cachekit-core-ts are not JSON" "$pr" GH_STUB_RAW='<html>'
bad manifest-not-json 2 1 "$cannot: the contents of .release-please-manifest.json on main are not JSON" "$packing" GH_STUB_MANIFEST_RAW='<html>'
bad not-list 2 1 'are not a list' "$pr" GH_STUB_RAW='{"message":"Not Found"}'
# A PR row this cannot read is not evidence that no release is pending.
unreadable="$cannot: an open pull request from release-please--branches--main--components--cachekit-core-ts has no readable head"
bad empty-row 2 1 "$unreadable" "$packing" GH_STUB_RAW='[{}]'
bad null-row 2 1 "$unreadable" "$packing" GH_STUB_RAW='[null]'
bad numeric-ref 2 1 "$unreadable" "$pr" GH_STUB_RAW='[{"head":{"ref":1,"repo":{"full_name":"cachekit-io/cachekit-ts"}}}]'
bad repo-without-name 2 1 "$unreadable" "$pr" GH_STUB_RAW='[{"head":{"ref":"x","repo":{}}}]'
bad manifest-not-object 2 1 '.release-please-manifest.json on main is not an object' "$packing" GH_STUB_MANIFEST_RAW='[]'
jq 'del(."packages/cachekit-core-wasm")' "$state/manifest" > "$state/m" && mv "$state/m" "$state/manifest" || exit 1
bad manifest-missing-core 2 1 "$cannot: .release-please-manifest.json on main has no version for packages/cachekit-core-wasm" "$packing"
fixture 0.2.0 0.2.0 0.2.0 0.2.0
bad no-repo 2 1 "$cannot: GITHUB_REPOSITORY is not set" "$pr" GITHUB_REPOSITORY=
bad usage 2 0 '' "$pr --packin"
rm "$tmp/work/packages/cachekit-core-ts/package.json"
bad no-core-manifest 2 1 "$cannot: cannot read packages/cachekit-core-ts/package.json" "$packing"
printf '%s\n' '{"name":"@cachekit-io/cachekit","dependencies":{"@cachekit-io/other":"workspace:*"}}' > "$tmp/work/packages/cachekit/package.json"
bad unknown-sibling 2 1 "$cannot: @cachekit-io/other is a workspace dependency with no release-please package" "$pr"
rm "$tmp/work/packages/cachekit/package.json"
bad no-manifest 2 1 "$cannot: cannot read packages/cachekit/package.json" "$pr"

if [ "$fail" -ne 0 ]; then echo "release-order-gate selftest FAILED"; exit 1; fi
echo "release-order-gate selftest OK ($(grep -cE '^(bad|good) ' "$0") fixtures)"
