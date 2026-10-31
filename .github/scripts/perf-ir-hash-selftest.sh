#!/usr/bin/env bash
# Self-test for `bench/ir.mjs --build-hash`, on a synthetic three-package tree.
# The instruction-count gate skips measuring when the base and head hashes
# match, so a file the workloads load that the hash misses lets a regression
# pass unmeasured. The hash must move when a shipped file of any package
# changes (here the wasm glue JavaScript, the NAPI loader, a package.json and
# the lockfile), stay put when an unshipped file changes, and not depend on
# where the tree sits. Needs node; no build, no valgrind.
set -euo pipefail
src=$(cd "$(dirname "$0")/../../packages/cachekit/bench" && pwd)
work=$(mktemp -d)
trap 'rm -rf "${work:?}"' EXIT

tree() {
  local root=$1 sdk=$1/packages/cachekit core=$1/packages/cachekit-core-ts wasm=$1/packages/cachekit-core-wasm
  mkdir -p "$sdk/dist" "$sdk/bench" "$sdk/node_modules/@cachekit-io" "$core" "$wasm/pkg"
  cp "$src"/ir.mjs "$src"/ir-workload.mjs "$src"/ir-seconds.json "$sdk/bench/"
  echo '{"files":["dist","README.md"]}' > "$sdk/package.json"
  echo 'export const x = 1;' > "$sdk/dist/index.js"
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
if [[ $(hash "$work/a") != $(hash "$work/a-copy-at-another-path") ]]; then
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
expect differs 'package.json' packages/cachekit-core-wasm/package.json ' '
expect differs 'lockfile' pnpm-lock.yaml '# x'
expect same 'unshipped README of a core' packages/cachekit-core-ts/README.md 'x'
exit "$fail"
