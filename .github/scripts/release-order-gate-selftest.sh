#!/usr/bin/env bash
# Regression fixtures for release-order-gate.mjs. Each fixture runs the real
# gate in a scratch directory holding this repo's release-please-config.json
# and an SDK that depends on both cores as workspace:*. gh is a stub that
# serves the open pull requests of each branch from a file, or fails, stalls or
# answers garbage when told to. Every `bad` fixture must exit with the given
# code and exactly the given number of ::error lines, each holding the given
# text. Every `good` fixture must exit 0. Add the shape here when you close a
# hole.
#
#   bash .github/scripts/release-order-gate-selftest.sh   (needs node, jq)
set -u
cd "$(dirname "$0")/../.." || exit 1
root=$PWD
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fail=0

mkdir -p "$tmp/bin" "$tmp/work/packages/cachekit"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
# gh api repos/<repo>/pulls?state=open&head=<owner>:<branch>&per_page=100
[ -z "${GH_STUB_FAIL:-}" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
[ -z "${GH_STUB_SLEEP:-}" ] || exec sleep "$GH_STUB_SLEEP" # the timeout kills sleep itself
[ -z "${GH_STUB_RAW:-}" ] || { printf '%s\n' "$GH_STUB_RAW"; exit 0; }
branch=${2#*head=*:}
branch=${branch%%&*}
cat "$GH_STUB_OPEN/$branch" 2>/dev/null || echo '[]'
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GITHUB_REPOSITORY=cachekit-io/cachekit-ts
cp "$root/release-please-config.json" "$tmp/work/" || exit 1
sdk='{"name":"@cachekit-io/cachekit","version":"0.2.1","dependencies":{"@cachekit-io/cachekit-core-ts":"workspace:*","@cachekit-io/cachekit-core-wasm":"workspace:*","@msgpack/msgpack":"^3.1.3"}}'

n=0
fixture() { # [component repo]...: a fresh state where each component's release branch has an open PR from repo
  n=$((n + 1))
  open=$tmp/open.$n
  mkdir -p "$open" && printf '%s\n' "$sdk" > "$tmp/work/packages/cachekit/package.json" || exit 1
  while [ "$#" -ge 2 ]; do
    branch=release-please--branches--main--components--$1
    jq -n --arg b "$branch" --arg r "$2" --arg c "$1" \
      '[{html_url: "https://github.com/\($r)/pull/1", title: "chore(main): release \($c) 9.9.9", head: {ref: $b, repo: {full_name: $r}}}]' \
      > "$open/$branch" || exit 1
    shift 2
  done
}
run() { # kind name code errors text [env...]
  local kind=$1 name=$2 code=$3 errors=$4 text=$5 out rc got
  shift 5
  out=$(cd "$tmp/work" && env GH_STUB_OPEN="$open" "$@" node "$root/.github/scripts/release-order-gate.mjs" packages/cachekit 2>&1)
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
bad() { run bad "$@"; }
good() { run good "$1" 0 0 '' "${@:2}"; }

us=cachekit-io/cachekit-ts
held='has an open release PR'
# --- an open core release PR refuses the SDK ----------------------------------
fixture cachekit-core-ts "$us"
bad core-ts 1 1 "@cachekit-io/cachekit-core-ts $held"
fixture cachekit-core-wasm "$us"
bad core-wasm 1 1 "@cachekit-io/cachekit-core-wasm $held"
# main at 1dc06f9: both cores' release PRs open.
fixture cachekit-core-ts "$us" cachekit-core-wasm "$us"
bad both 1 2 "$held"
# --- no open core release PR lets the SDK through -----------------------------
# main at d400cfd: no release PR open.
fixture
good none
# The SDK's own release PR is the one being checked, not a hold.
fixture cachekit "$us"
good sdk-own
# A fork's branch of the same name, should the server's head filter let it by.
fixture cachekit-core-ts someone/cachekit-ts
good fork
# --- anything unreadable refuses ----------------------------------------------
cannot='Cannot check release order'
fixture
bad api-down 2 1 "$cannot: gh api" GH_STUB_FAIL=1
bad api-stalls 2 1 "timed out after 500 ms" GH_STUB_SLEEP=5 RELEASE_ORDER_GATE_TIMEOUT_MS=500
bad not-json 2 1 "$cannot: the open pull requests from release-please--branches--main--components--cachekit-core-ts are not JSON" GH_STUB_RAW='<html>'
bad not-list 2 1 'are not a list' GH_STUB_RAW='{"message":"Not Found"}'
bad no-repo 2 1 "$cannot: GITHUB_REPOSITORY is not set" GITHUB_REPOSITORY=
printf '%s\n' '{"name":"@cachekit-io/cachekit","dependencies":{"@cachekit-io/other":"workspace:*"}}' > "$tmp/work/packages/cachekit/package.json"
bad unknown-sibling 2 1 "$cannot: @cachekit-io/other is a workspace dependency with no release-please package"
rm "$tmp/work/packages/cachekit/package.json"
bad no-manifest 2 1 "$cannot: cannot read packages/cachekit/package.json"

if [ "$fail" -ne 0 ]; then echo "release-order-gate selftest FAILED"; exit 1; fi
echo "release-order-gate selftest OK ($(grep -cE '^(bad|good) ' "$0") fixtures)"
