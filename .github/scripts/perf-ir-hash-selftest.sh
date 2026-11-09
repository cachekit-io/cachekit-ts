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
# synthetic repo of that tree. On a core's release PR, the base must be the
# PR's own tree outside the core's package, so SDK drift since the core's tag
# cannot fail the gate, and the core's own drift must hash apart, measured
# against the tagged core. A PR on a
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
# set_json <file> <jq filter>
set_json() { jq "$2" "$1" > "$1.new" && mv "$1.new" "$1"; }
# The released repo: core-wasm's release, then a later SDK release that also
# changed the core, so each tag names a tree of its own. The core's tag carries
# a dependenciesMeta, so a scenario can change or drop it.
origin=$work/origin
tree "$origin"
cp "$scripts/../../release-please-config.json" "$scripts/../../.release-please-manifest.json" "$origin/"
sdk_tag=cachekit-v$(jq -r '.["packages/cachekit"]' "$origin/.release-please-manifest.json")
wasm_tag=cachekit-core-wasm-v$(jq -r '.["packages/cachekit-core-wasm"]' "$origin/.release-please-manifest.json")
sdk=packages/cachekit/dist/index.js glue=packages/cachekit-core-wasm/pkg/glue.js
added=packages/cachekit-core-wasm/pkg/added.js wasm=packages/cachekit-core-wasm
set_json "$origin/$wasm/package.json" '.dependenciesMeta = {"y": {"injected": true}}'
g "$origin" init -q -b main
g "$origin" add -A
g "$origin" commit -q -m 'core-wasm release'
g "$origin" tag "$wasm_tag"
echo '// SDK release' | tee -a "$origin/$sdk" >> "$origin/$glue"
g "$origin" commit -q -am 'SDK release'
g "$origin" tag "$sdk_tag"

# pick <scenario> <PR head branch> <PR file|-> <file>...: append to each <file>
# on main after the releases (and run $DRIFT on the repo, if set), then open
# the PR. A release PR edits what release-please edits: the package's version,
# its CHANGELOG.md and its manifest entry. The PR also appends to <PR file>.
# Check out its merge commit, and pick and build the base trees as CI does.
pick() {
  local repo=$work/$1 path
  git clone -q --no-tags "file://$origin" "$repo"
  for f in "${@:4}"; do echo '// drift' >> "$repo/$f"; done
  [[ -z ${DRIFT:-} ]] || "$DRIFT" "$repo"
  g "$repo" add -A
  g "$repo" commit -q -m drift
  g "$repo" switch -q -c pr
  if [[ $2 == *--components--* ]]; then
    path=$(jq -r --arg c "${2##*--components--}" \
      '.packages | to_entries[] | select(.value.component == $c) | .key' "$repo/release-please-config.json")
    set_json "$repo/$path/package.json" '.version = "9.9.9"'
    set_json "$repo/.release-please-manifest.json" ".[\"$path\"] = \"9.9.9\""
    echo 'release notes' >> "$repo/$path/CHANGELOG.md"
  fi
  [[ $3 == - ]] || echo '// the PR' >> "$repo/$3"
  g "$repo" add -A
  g "$repo" commit -q -m 'the PR'
  g "$repo" switch -q --detach main
  g "$repo" merge -q --no-ff -m merge pr
  mkdir -p "$work/$1-out"
  (cd "$repo" && HEAD_REF=$2 GITHUB_OUTPUT=$work/$1-out/base bash "$scripts/perf-ir-base.sh" > /dev/null)
  (cd "$repo" && BASE_SHA=$(out "$1" sha) BASE_PACKAGE=$(out "$1" package) OUT=$work/$1-out IR_ROOT=$work/$1-ir \
    bash "$scripts/perf-ir.sh" trees > "$work/$1-out/trees.log")
}
# A core change since its tag that the SDK's bench relies on: a dependency
# bump and a workload the tagged core may not run.
core_api() {
  set_json "$1/$wasm/package.json" '.devDependencies = {"x": "^2.0.0"}'
  echo "WORKLOADS['added-since-tag'] = WORKLOADS.keygen;" >> "$1/packages/cachekit/bench/ir-workload.mjs"
}
# A core change since its tag to dependenciesMeta alone, which the head's
# lockfile records like the dependency fields: changed, or dropped.
core_meta() {
  set_json "$1/$wasm/package.json" '.dependenciesMeta = {"x": {"injected": true}}'
  echo '# dependenciesMeta' >> "$1/pnpm-lock.yaml"
}
core_meta_dropped() { set_json "$1/$wasm/package.json" 'del(.dependenciesMeta)'; }
out() { sed -n "s/^$2=//p" "$work/$1-out/base"; }
assert() { # assert <label> <command>...: passes when the command succeeds
  if "${@:2}"; then echo "ok: $1"; else
    echo "FAIL: $1"
    fail=1
  fi
}
head_outside_core() { # the base's files outside the core are the PR merge commit's
  [[ -n $(out "$1" package) ]] && git -C "$work/$1-ir/base" diff --quiet "$(g "$work/$1" rev-parse HEAD)" -- . ":!$wasm/"
}
warned() { grep -q "dependencies changed since its tag" "$work/$1-out/trees.log"; }
not_warned() { ! warned "$1"; }
other_hash() { [[ $(hash "$work/$1-ir/base") != "$(hash "$work/$1-ir/head")" ]]; }
from_tag() { [[ $(cat "$work/$1-ir/base/$3") == "$(g "$origin" show "$2:$3")" ]]; }
absent() { [[ ! -e $work/$1-ir/base/$2 ]]; }
# The base's core package.json: the head's dependency fields, the rest the tag's.
manifest_mix() {
  local fields='["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "dependenciesMeta"]'
  local deps="with_entries(select(.key | IN(${fields}[])))" rest="with_entries(select(.key | IN(${fields}[]) | not))"
  local base=$work/$1-ir/base/$wasm/package.json head=$work/$1-ir/head/$wasm/package.json
  [[ $(jq -c "$deps" "$base") == "$(jq -c "$deps" "$head")" &&
    $(jq -c "$rest" "$base") == "$(g "$origin" show "$wasm_tag:$wasm/package.json" | jq -c "$rest")" ]]
}
new_on_base() { ! grep -qx "$2" "$work/$1-out/base-workloads.txt" && grep -qx "$2" "$work/$1-out/head-workloads.txt"; }
whole_tag() { [[ -z $(out "$1" package) && $(out "$1" sha) == "$(g "$origin" rev-parse "$2^{commit}")" ]] && from_tag "$@"; }
first_parent() { [[ $(out "$1" sha) == "$(g "$work/$1" rev-parse HEAD^1)" && -z $(out "$1" package) ]]; }
rp=release-please--branches--main--components--

pick core-sdk-drift "${rp}cachekit-core-wasm" - "$sdk"
assert "core release PR: outside the core's package, the base is the head" head_outside_core core-sdk-drift
assert 'core release PR: no dependency warning when the dependencies are unchanged' not_warned core-sdk-drift

DRIFT=core_api pick core-drift "${rp}cachekit-core-wasm" - "$sdk" "$glue" "$added"
assert "core release PR: the core's drift since its tag hashes apart" other_hash core-drift
assert "core release PR: the base's core file is the core tag's" from_tag core-drift "$wasm_tag" "$glue"
assert 'core release PR: a core file added since the tag is absent from the base' absent core-drift "$added"
assert "core release PR: the base's core package.json is the tag's with the head's dependencies" manifest_mix core-drift
assert 'core release PR: a dependency change since the tag is warned about' warned core-drift
assert 'core release PR: a workload added since the tag reads new' new_on_base core-drift added-since-tag

DRIFT=core_meta pick core-meta "${rp}cachekit-core-wasm" - "$sdk"
assert "core release PR: the base's core package.json carries the head's dependenciesMeta" manifest_mix core-meta
assert 'core release PR: a dependenciesMeta change since the tag is warned about' warned core-meta
assert "core release PR: the base's lockfile is the head's, which records that change" head_outside_core core-meta

DRIFT=core_meta_dropped pick core-meta-dropped "${rp}cachekit-core-wasm" - "$sdk"
assert "core release PR: the base's core package.json drops the dependenciesMeta the head dropped" \
  manifest_mix core-meta-dropped

pick sdk-change "${rp}cachekit-core-wasm" "$sdk" "$sdk"
assert "a core release branch's PR that changes the SDK: the base is the whole core tag tree" \
  whole_tag sdk-change "$wasm_tag" "$sdk"

pick sdk-release "${rp}cachekit" - "$sdk" "$glue"
assert 'SDK release PR: the base is the whole SDK tag tree' whole_tag sdk-release "$sdk_tag" "$sdk"

pick feature feature/x "$sdk" "$sdk"
assert 'feature PR: the base is HEAD^1, whole' first_parent feature
exit "$fail"
