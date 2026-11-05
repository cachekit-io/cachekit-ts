#!/usr/bin/env bash
# shellcheck disable=SC2329 # the checks run through assert and $DRIFT
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
# core's own drift must hash apart, measured against the tagged core. A PR on a
# core's release branch that changes the SDK, the SDK's release PR and a
# feature PR keep the whole-tree bases: the tag, and HEAD^1.
# Needs node, git and jq; no build, no valgrind.
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
# The released repo: the SDK's and core-wasm's tags on one commit, as if both
# had just released.
origin=$work/origin
tree "$origin"
cp "$scripts/../../release-please-config.json" "$scripts/../../.release-please-manifest.json" "$origin/"
sdk_version=$(jq -r '.["packages/cachekit"]' "$origin/.release-please-manifest.json")
wasm_version=$(jq -r '.["packages/cachekit-core-wasm"]' "$origin/.release-please-manifest.json")
g "$origin" init -q -b main
g "$origin" add -A
g "$origin" commit -q -m release
g "$origin" tag "cachekit-v$sdk_version"
g "$origin" tag "cachekit-core-wasm-v$wasm_version"

# pick <scenario> <PR head branch> <PR file> <file>...: append to each <file>
# on main after the release (and run $DRIFT on the repo, if set), then open
# the PR, which appends to <PR file>. Check out its merge commit, and pick and
# build the base trees as CI does.
pick() {
  local repo=$work/$1
  git clone -q --no-tags "file://$origin" "$repo"
  for f in "${@:4}"; do echo '// drift' >> "$repo/$f"; done
  [[ -z ${DRIFT:-} ]] || "$DRIFT" "$repo"
  g "$repo" add -A
  g "$repo" commit -q -m drift
  g "$repo" switch -q -c pr
  echo '// the PR' >> "$repo/$3"
  g "$repo" add -A
  g "$repo" commit -q -m 'the PR'
  g "$repo" switch -q --detach main
  g "$repo" merge -q --no-ff -m merge pr
  mkdir -p "$work/$1-out"
  (cd "$repo" && HEAD_REF=$2 GITHUB_OUTPUT=$work/$1-out/base bash "$scripts/perf-ir-base.sh" > /dev/null)
  (cd "$repo" && BASE_SHA=$(out "$1" sha) BASE_PACKAGE=$(out "$1" package) OUT=$work/$1-out IR_ROOT=$work/$1-ir \
    bash "$scripts/perf-ir.sh" trees)
}
# A core change since its tag that the SDK's bench relies on: a dependency
# bump and a workload the tagged core may not run.
core_api() {
  jq '.devDependencies = {"x": "^2.0.0"}' "$1/packages/cachekit-core-wasm/package.json" > "$1/package.json.new"
  mv "$1/package.json.new" "$1/packages/cachekit-core-wasm/package.json"
  echo "WORKLOADS['added-since-tag'] = WORKLOADS.keygen;" >> "$1/packages/cachekit/bench/ir-workload.mjs"
}
out() { sed -n "s/^$2=//p" "$work/$1-out/base"; }
assert() { # assert <label> <command>...: passes when the command succeeds
  if "${@:2}"; then echo "ok: $1"; else
    echo "FAIL: $1"
    fail=1
  fi
}
same_hash() { [[ $(hash "$work/$1-ir/base") == "$(hash "$work/$1-ir/head")" ]]; }
other_hash() { ! same_hash "$1"; }
from_tag() { [[ $(cat "$work/$1-ir/base/$2") == "$(g "$origin" show "cachekit-v$sdk_version:$2")" ]]; }
absent() { [[ ! -e $work/$1-ir/base/$2 ]]; }
head_deps() {
  local manifest=packages/cachekit-core-wasm/package.json
  [[ $(jq -c .devDependencies "$work/$1-ir/base/$manifest") == "$(jq -c .devDependencies "$work/$1-ir/head/$manifest")" ]]
}
new_on_base() { ! grep -qx "$2" "$work/$1-out/base-workloads.txt" && grep -qx "$2" "$work/$1-out/head-workloads.txt"; }
whole_tag() { [[ -z $(out "$1" package) ]] && from_tag "$1" "$2"; }
first_parent() { [[ $(out "$1" sha) == "$(g "$work/$1" rev-parse HEAD^1)" && -z $(out "$1" package) ]]; }
rp=release-please--branches--main--components--
sdk=packages/cachekit/dist/index.js glue=packages/cachekit-core-wasm/pkg/glue.js
changelog=packages/cachekit-core-wasm/CHANGELOG.md added=packages/cachekit-core-wasm/pkg/added.js

pick core-sdk-drift "${rp}cachekit-core-wasm" "$changelog" "$sdk"
assert 'core release PR: SDK drift since the core tag hashes alike' same_hash core-sdk-drift

DRIFT=core_api pick core-drift "${rp}cachekit-core-wasm" "$changelog" "$sdk" "$glue" "$added"
assert "core release PR: the core's drift since its tag hashes apart" other_hash core-drift
assert "core release PR: the base's core file is the tag's" from_tag core-drift "$glue"
assert 'core release PR: a core file added since the tag is absent from the base' absent core-drift "$added"
assert "core release PR: the base keeps the head's core dependencies" head_deps core-drift
assert 'core release PR: a workload added since the tag reads new' new_on_base core-drift added-since-tag

pick sdk-change "${rp}cachekit-core-wasm" "$sdk" "$sdk"
assert "a core release branch's PR that changes the SDK: the base is the whole tag tree" whole_tag sdk-change "$sdk"

pick sdk-release "${rp}cachekit" "$changelog" "$sdk" "$glue"
assert 'SDK release PR: the base is the whole tag tree' whole_tag sdk-release "$sdk"
assert "SDK release PR: the base's core file is the tag's" from_tag sdk-release "$glue"

pick feature feature/x "$changelog" "$sdk"
assert 'feature PR: the base is HEAD^1, whole' first_parent feature
exit "$fail"
