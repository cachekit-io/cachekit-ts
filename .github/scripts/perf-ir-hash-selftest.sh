#!/usr/bin/env bash
# Self-test for `bench/ir.mjs --build-hash`, on a synthetic three-package tree.
# The instruction-count gate skips measuring when the base and head hashes
# match, so a file the workloads load that the hash misses lets a regression
# pass unmeasured. The hash must move when a shipped file of any package or
# the lockfile changes, stay put when an unshipped file changes, and not
# depend on where the tree sits.
#
# Then the base the gate builds (perf-ir-base.sh, then perf-ir.sh trees), on a
# synthetic repo of that tree. On a core's release PR, SDK drift since the
# core's tag must hash alike on both trees, so it cannot fail the gate, and the
# core's own drift must hash apart, measured against the tagged core. The SDK's
# release PR and a feature PR keep their bases: the SDK's tag, and HEAD^1.
# Needs node and git; no build, no valgrind.
set -euo pipefail
scripts=$(cd "$(dirname "$0")" && pwd)
src=$(cd "$scripts/../../packages/cachekit/bench" && pwd)
work=$(mktemp -d)
trap 'rm -rf "${work:?}"' EXIT

tree() {
  local root=$1 sdk=$1/packages/cachekit core=$1/packages/cachekit-core-ts wasm=$1/packages/cachekit-core-wasm
  mkdir -p "$sdk/dist/serialization" "$sdk/bench" "$sdk/node_modules/@cachekit-io" "$core" "$wasm/pkg"
  cp "$src"/ir.mjs "$src"/ir-workload.mjs "$src"/ir-seconds.json "$sdk/bench/"
  echo '{"files":["dist","README.md"]}' > "$sdk/package.json"
  echo 'export const x = 1;' > "$sdk/dist/index.js"
  echo 'export const generateKey = () => "";' > "$sdk/dist/serialization/key-generator.js"
  echo 'readme' > "$sdk/README.md"
  echo '{"main":"./index.js","files":["index.js","*.node"]}' > "$core/package.json"
  echo 'module.exports = require("./core.linux-x64-gnu.node");' > "$core/index.js"
  echo 'binary' > "$core/core.linux-x64-gnu.node"
  echo 'unshipped' > "$core/README.md"
  echo '{"exports":{".":"./index.js"},"files":["index.js","pkg/"]}' > "$wasm/package.json"
  echo 'export * from "./pkg/glue.js";' > "$wasm/index.js"
  echo 'export function blake2b256Hex(data) {}' > "$wasm/pkg/glue.js"
  echo 'wasm' > "$wasm/pkg/glue_bg.wasm"
  echo 'lockfileVersion: 9' > "$root/pnpm-lock.yaml"
  ln -s ../../../cachekit-core-ts "$sdk/node_modules/@cachekit-io/cachekit-core-ts"
  ln -s ../../../cachekit-core-wasm "$sdk/node_modules/@cachekit-io/cachekit-core-wasm"
}
hash() { (cd "$1/packages/cachekit" && node bench/ir.mjs --build-hash); }

fail=0
expect() { # expect same|differs <label> <file> <line to append>
  local was now
  was=$(hash "$work/a")
  cp "$work/a/$3" "$work/saved"
  echo "$4" >> "$work/a/$3"
  now=$(hash "$work/a")
  cp "$work/saved" "$work/a/$3"
  if [[ ($1 == same && $was != "$now") || ($1 == differs && $was == "$now") ]]; then
    echo "FAIL: $2: expected the hash to read '$1', got $was -> $now"
    fail=1
  else
    echo "ok: $2"
  fi
}

tree "$work/a"
tree "$work/a-copy-at-another-path"
here=$(hash "$work/a")
there=$(hash "$work/a-copy-at-another-path")
if [[ $here != "$there" ]]; then
  echo "FAIL: identical trees at different paths hash differently"
  fail=1
else
  echo "ok: identical trees at different paths hash alike"
fi
expect differs 'wasm glue JavaScript' packages/cachekit-core-wasm/pkg/glue.js 'data = new Uint8Array(data);'
expect differs 'wasm module' packages/cachekit-core-wasm/pkg/glue_bg.wasm 'x'
expect differs 'NAPI loader' packages/cachekit-core-ts/index.js '// x'
expect differs 'NAPI binary' packages/cachekit-core-ts/core.linux-x64-gnu.node 'x'
expect differs 'SDK dist' packages/cachekit/dist/index.js '// x'
expect differs 'nested SDK dist' packages/cachekit/dist/serialization/key-generator.js '// x'
expect differs 'package.json' packages/cachekit-core-wasm/package.json ' '
expect differs 'lockfile' pnpm-lock.yaml '# x'
expect same 'unshipped README of a core' packages/cachekit-core-ts/README.md 'x'
# A files glob that matches nothing would add nothing: the hash must refuse it.
echo '{"main":"./index.js","files":["index.js","*.dylib"]}' > "$work/a/packages/cachekit-core-ts/package.json"
if hash "$work/a" > /dev/null 2>&1; then
  echo "FAIL: a files glob that matches nothing was hashed"
  fail=1
else
  echo "ok: a files glob that matches nothing fails the run"
fi

g() { git -C "$1" -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null "${@:2}"; }
# The released repo: both tags on one commit, as if every package had just
# released.
origin=$work/origin
tree "$origin"
cp "$scripts/../../release-please-config.json" "$scripts/../../.release-please-manifest.json" "$origin/"
manifest=$(jq -r '.["packages/cachekit"] as $s | .["packages/cachekit-core-wasm"] as $w | "\($s) \($w)"' \
  "$origin/.release-please-manifest.json")
g "$origin" init -q -b main
g "$origin" add -A
g "$origin" commit -q -m release
g "$origin" tag "cachekit-v${manifest% *}"
g "$origin" tag "cachekit-core-wasm-v${manifest#* }"

# pick <scenario> <PR head branch> <file>...: append to each file on main after
# the release, check out the PR's merge commit (its own change touches only an
# unshipped changelog), and pick and build the base trees as CI does.
pick() {
  local repo=$work/$1
  git clone -q --no-tags "file://$origin" "$repo"
  for f in "${@:3}"; do echo '// drift' >> "$repo/$f"; done
  g "$repo" add -A
  g "$repo" commit -q -m drift
  g "$repo" switch -q -c pr
  echo 'changelog' >> "$repo/packages/cachekit-core-wasm/CHANGELOG.md"
  g "$repo" add -A
  g "$repo" commit -q -m 'the PR'
  g "$repo" switch -q --detach main
  g "$repo" merge -q --no-ff -m merge pr
  mkdir -p "$work/$1-out"
  (cd "$repo" && HEAD_REF=$2 GITHUB_OUTPUT=$work/$1-out/base bash "$scripts/perf-ir-base.sh" > /dev/null)
  local sha package
  sha=$(sed -n 's/^sha=//p' "$work/$1-out/base")
  package=$(sed -n 's/^package=//p' "$work/$1-out/base")
  (cd "$repo" && BASE_SHA=$sha BASE_PACKAGE=$package OUT=$work/$1-out IR_ROOT=$work/$1-ir \
    bash "$scripts/perf-ir.sh" trees)
}
check() { # check <scenario> same|differs <label>
  local base head
  base=$(hash "$work/$1-ir/base")
  head=$(hash "$work/$1-ir/head")
  if [[ ($2 == same && $base != "$head") || ($2 == differs && $base == "$head") ]]; then
    echo "FAIL: $3: expected the base and head hashes to read '$2', got $base and $head"
    fail=1
  else
    echo "ok: $3"
  fi
}
# file <scenario> <path> <expected source>: the base tree's file must match
# the release (tag) or the PR (head), or be absent from the base (none).
file() {
  local want ok=1
  case $3 in
    tag) want=$(g "$origin" show "cachekit-v${manifest% *}:$2") ;; # both tags name one commit
    head) want=$(cat "$work/$1-ir/head/$2") ;;
  esac
  if [[ $3 == none ]]; then
    [[ ! -e $work/$1-ir/base/$2 ]] || ok=
  else
    [[ -f $work/$1-ir/base/$2 && $(cat "$work/$1-ir/base/$2") == "$want" ]] || ok=
  fi
  local what="the $3's"
  [[ $3 != none ]] || what=absent
  if [[ -n $ok ]]; then echo "ok: $1: the base's $2 is $what"; else
    echo "FAIL: $1: the base's $2 is not $what"
    fail=1
  fi
}
rp=release-please--branches--main--components--
sdk=packages/cachekit/dist/index.js glue=packages/cachekit-core-wasm/pkg/glue.js
added=packages/cachekit-core-wasm/pkg/added.js

pick core-sdk-drift "${rp}cachekit-core-wasm" "$sdk"
check core-sdk-drift same 'core release PR: SDK drift since the core tag hashes alike'
file core-sdk-drift "$sdk" head

pick core-drift "${rp}cachekit-core-wasm" "$sdk" "$glue" "$added"
check core-drift differs "core release PR: the core's drift since its tag hashes apart"
file core-drift "$glue" tag
file core-drift "$added" none
file core-drift "$sdk" head

pick sdk-release "${rp}cachekit" "$sdk" "$glue"
check sdk-release differs 'SDK release PR: drift since the SDK tag hashes apart'
file sdk-release "$sdk" tag
file sdk-release "$glue" tag

pick feature feature/x "$sdk"
if [[ $(sed -n 's/^sha=//p' "$work/feature-out/base") == $(g "$work/feature" rev-parse HEAD^1) &&
  -z $(sed -n 's/^package=//p' "$work/feature-out/base") ]]; then
  echo 'ok: feature PR: the base is HEAD^1, whole'
else
  echo 'FAIL: feature PR: the base is not HEAD^1, whole'
  fail=1
fi
exit "$fail"
