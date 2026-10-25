#!/usr/bin/env bash
# Regression fixtures for release-order-gate.mjs. Each fixture is a branch of a
# scratch repository holding this repo's release-please-config.json, an SDK
# that depends on both cores as workspace:*, and both cores tagged at 0.2.0.
# gh is a stub that serves each commit's pull request body from a file, or
# fails when told to. Every `bad` fixture must exit with the given code and
# exactly the given number of ::error lines, each holding the given text.
# Every `good` fixture must exit 0. Add the shape here when you close a hole.
#
#   bash .github/scripts/release-order-gate-selftest.sh   (needs git, node)
set -u
cd "$(dirname "$0")/../.." || exit 1
root=$PWD
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fail=0

mkdir -p "$tmp/bin" "$tmp/prs"
cat > "$tmp/bin/gh" <<'GH'
#!/usr/bin/env bash
# gh api repos/<repo>/commits/<sha>/pulls
[ -z "${GH_STUB_FAIL:-}" ] || { echo "HTTP 502: Bad Gateway" >&2; exit 1; }
sha=${2%/pulls}
sha=${sha##*/}
if [ -f "$GH_STUB_PRS/$sha" ]; then
  jq -n --arg sha "$sha" --rawfile body "$GH_STUB_PRS/$sha" '[{merge_commit_sha: $sha, body: $body}]'
else
  echo '[]'
fi
GH
chmod +x "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH" GH_STUB_PRS="$tmp/prs" GITHUB_REPOSITORY=selftest/selftest
export GIT_AUTHOR_NAME=selftest GIT_AUTHOR_EMAIL=selftest@example.com GIT_COMMITTER_NAME=selftest \
  GIT_COMMITTER_EMAIL=selftest@example.com GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

repo=$tmp/repo
version() { # dir version
  mkdir -p "$repo/$1" && printf '{"name":"@cachekit-io/%s","version":"%s"}\n' "${1#packages/}" "$2" > "$repo/$1/package.json"
}
git init -q -b main "$repo" || exit 1
cp "$root/release-please-config.json" "$repo/" || exit 1
mkdir -p "$repo/packages/cachekit"
printf '%s\n' '{"name":"@cachekit-io/cachekit","version":"0.2.1","dependencies":{"@cachekit-io/cachekit-core-ts":"workspace:*","@cachekit-io/cachekit-core-wasm":"workspace:*","@msgpack/msgpack":"^3.1.3"}}' \
  > "$repo/packages/cachekit/package.json"
version packages/cachekit-core-ts 0.2.0
version packages/cachekit-core-wasm 0.2.0
g() { git -C "$repo" "$@"; }
g add -A && g commit -qm 'chore: init' && g tag cachekit-core-ts-v0.2.0 && g tag cachekit-core-wasm-v0.2.0 || exit 1

fixture() { g checkout -q -B "$1" main || exit 1; } # name: a branch off the tagged base
change() { # path message [pr-body]: one commit touching path, with that message
  echo "$RANDOM" >> "$repo/$1" && g add -A && g commit -qm "$2" || exit 1
  [ "$#" -lt 3 ] || printf '%s' "$3" > "$tmp/prs/$(g rev-parse HEAD)"
}
run() { # kind name code errors text [env...]
  local kind=$1 name=$2 code=$3 errors=$4 text=$5 out rc got
  shift 5
  out=$(cd "$repo" && env "$@" node "$root/.github/scripts/release-order-gate.mjs" packages/cachekit "$name" 2>&1)
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

ts=packages/cachekit-core-ts/src.rs wasm=packages/cachekit-core-wasm/src.rs sdk=packages/cachekit/src.ts
ahead='releasable change(s) since'
# --- a core with releasable commits refuses the SDK ---------------------------
fixture fix && change "$ts" 'fix(cachekit-core-ts): a fix'
bad fix 1 1 "@cachekit-io/cachekit-core-ts has 1 $ahead cachekit-core-ts-v0.2.0"
fixture both && change "$ts" 'feat: a feature' && change "$wasm" 'perf(cachekit-core-wasm): faster'
bad both 1 2 "$ahead"
fixture security && change "$wasm" 'security: a fix'
bad security 1 1 "@cachekit-io/cachekit-core-wasm has 1 $ahead"
fixture bang && change "$ts" 'refactor(cachekit-core-ts)!: drop an export'
bad bang 1 1 "$ahead"
fixture footer && change "$ts" $'chore: rename\n\nBREAKING CHANGE: an export is gone'
bad footer 1 1 "$ahead"
fixture nested && change "$ts" $'chore(deps): bump\n\nfix(cachekit-core-ts): a second message in the body'
bad nested 1 1 "$ahead"
fixture nested-block && change "$ts" $'chore: bump\n\nBEGIN_NESTED_COMMIT\nfix: nested\nEND_NESTED_COMMIT'
bad nested-block 1 1 "$ahead"
# A hidden type recast as releasable in its PR body, as release-please reads it.
fixture override-up && change "$ts" 'chore(deps): update a crate' $'Body.\r\n\r\nBEGIN_COMMIT_OVERRIDE\r\nfix(deps): update a crate\r\nEND_COMMIT_OVERRIDE\r\n'
bad override-up 1 1 "$ahead"
# --- nothing releasable since the tag lets the SDK through ---------------------
fixture clean
good clean
fixture hidden && change "$ts" 'docs(cachekit-core-ts): a note' && change "$wasm" 'chore: tidy' && change "$ts" 'test: more' && change "$ts" 'not conventional'
good hidden
fixture sdk-only && change "$sdk" 'feat(cachekit): uses no core change'
good sdk-only
fixture override-down && change "$ts" 'fix: really a chore' $'BEGIN_COMMIT_OVERRIDE\nchore: really a chore\nEND_COMMIT_OVERRIDE'
good override-down
fixture released && change "$ts" 'fix: a fix' && version packages/cachekit-core-ts 0.2.1 && change "$ts" 'chore(main): release cachekit-core-ts 0.2.1' &&
  g tag cachekit-core-ts-v0.2.1
good released
# --- anything unreadable refuses ----------------------------------------------
cannot='Cannot check release order'
fixture no-tag && version packages/cachekit-core-ts 0.3.0 && change "$ts" 'chore(main): release cachekit-core-ts 0.3.0'
bad no-tag 2 1 "$cannot: no tag cachekit-core-ts-v0.3.0"
# Tags are repository-wide: released's 0.2.1 tag is on another branch.
fixture tag-elsewhere && version packages/cachekit-core-ts 0.2.1 && change "$ts" 'chore(main): release cachekit-core-ts 0.2.1'
bad tag-elsewhere 2 1 "$cannot: cachekit-core-ts-v0.2.1 is not an ancestor"
fixture api-down && change "$ts" 'chore: tidy'
bad api-down 2 1 "$cannot: gh api" GH_STUB_FAIL=1
bad no-such-rev 2 1 "$cannot: git rev-parse"
bad clean 2 1 "$cannot: GITHUB_REPOSITORY is not set" GITHUB_REPOSITORY=
g checkout -q --orphan off-history && g commit -qm 'chore: unrelated root' || exit 1
bad off-history 2 1 "$cannot: cachekit-core-ts-v0.2.0 is not an ancestor"
fixture unknown-sibling && printf '%s\n' '{"name":"@cachekit-io/cachekit","version":"0.2.1","dependencies":{"@cachekit-io/other":"workspace:*"}}' \
  > "$repo/packages/cachekit/package.json" && change "$sdk" 'chore: depend on another workspace package'
bad unknown-sibling 2 1 "$cannot: @cachekit-io/other is a workspace dependency with no release-please package"

if [ "$fail" -ne 0 ]; then echo "release-order-gate selftest FAILED"; exit 1; fi
echo "release-order-gate selftest OK ($(grep -cE '^(bad|good) ' "$0") fixtures)"
