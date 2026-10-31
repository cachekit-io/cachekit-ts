#!/usr/bin/env bash
# Build a pull request and its base side by side and gate the PR's
# instructions per op against the base's (packages/cachekit/bench/ir.mjs).
# Run from a checkout of the PR merge commit, with Node, pnpm, Rust, the wasm
# tools and valgrind on PATH. `trees` checks the two trees out under $IR_ROOT
# (default $RUNNER_TEMP/ir, which must lie outside the checkout); `measure`
# builds them and writes $OUT/report.json, ir.mjs's --report, or
# $OUT/same-build when both builds hash alike, and exits with ir.mjs's code.
# CI restores the Rust cache into the trees between the two.
#
#   BASE_SHA=<sha> OUT=<dir> bash .github/scripts/perf-ir.sh trees
#   OUT=<dir> [IR_ARGS='--shard 1/4'] bash .github/scripts/perf-ir.sh measure
#
# IR_ARGS goes to both ir.mjs runs after --jobs 4, word-split: --shard, or
# --only, --repeats and a larger --jobs for a quick local try.
#
# Both trees use the head's bench/, so both arms measure the same workload
# definitions, and a workload the PR adds is measured on the base too where
# the base can run it (ir.mjs --new). They sit at paths of equal length:
# where a process's heap starts moves with its argv, and the GC-sensitive
# workloads move with it.
#
# The trees sit outside the checkout: cargo and rustup read .cargo/config.toml
# and rust-toolchain.toml in every parent directory, so trees nested in the
# head checkout would both build with the head's copies, and a PR that changes
# only those would hash alike on both sides and pass unmeasured.
set -euo pipefail
: "${OUT:?}"
root=${IR_ROOT:-${RUNNER_TEMP:?set IR_ROOT outside this checkout}/ir}
mkdir -p "$OUT"

# The workloads a tree's own bench file defines, in its order; none when it
# has no bench file. A file that fails to load fails the step: an empty list
# would let any workload that fails on the base read `new`, which is not
# gated, instead of INCOMPLETE.
workloads() {
  [[ -f $1/packages/cachekit/bench/ir-workload.mjs ]] || return 0
  (cd "$1/packages/cachekit" && node --input-type=module -e \
    "console.log(Object.keys((await import('./bench/ir-workload.mjs')).WORKLOADS).join('\n'))")
}

if [[ ${1:-} == trees ]]; then
  : "${BASE_SHA:?}"
  git cat-file -e "$BASE_SHA^{commit}" 2> /dev/null ||
    git fetch --quiet --no-tags --depth=1 origin "$BASE_SHA"
  git worktree add --quiet --detach "$root/head" HEAD
  git worktree add --quiet --detach "$root/base" "$BASE_SHA"
  # Listed before the head's bench/ replaces the base's.
  workloads "$root/base" > "$OUT/base-workloads.txt"
  workloads "$root/head" > "$OUT/head-workloads.txt"
  rm -rf "${root:?}/base/packages/cachekit/bench"
  cp -R "$root/head/packages/cachekit/bench" "$root/base/packages/cachekit/bench"
  exit 0
fi
[[ ${1:-} == measure ]] || {
  echo "usage: perf-ir.sh trees|measure" >&2
  exit 2
}
read -ra extra <<< "${IR_ARGS:-}"
new=$(comm -13 <(sort "$OUT/base-workloads.txt") <(sort "$OUT/head-workloads.txt") | paste -sd, -)

for tree in base head; do
  echo "::group::Build the $tree"
  (
    cd "$root/$tree"
    pnpm install --frozen-lockfile
    # turbo shares its cache across worktrees: when the core's inputs match,
    # the second tree would restore the first tree's .node, skip `napi build`,
    # and keep its committed loader (turbo.json's outputs omit index.js and
    # index.d.ts), while the first tree's build regenerated it. The two builds
    # then hash apart. Each tree builds its own.
    TURBO_FORCE=true pnpm build
    pnpm --filter @cachekit-io/cachekit-core-wasm build:wasm
  )
  echo "::endgroup::"
done

ir() { (cd "$root/$1/packages/cachekit" && node bench/ir.mjs "${@:2}"); }
base_hash=$(ir base --build-hash)
head_hash=$(ir head --build-hash)
if [[ $base_hash == "$head_hash" ]]; then
  echo "Both builds hash to $head_hash: the PR changes nothing the workloads execute."
  echo "$head_hash" > "$OUT/same-build"
  exit 0
fi

# The base run records a workload that fails (exit 4) or repeats noisily
# (exit 3) in its --save file, and the compare reads them from there.
# Exit 4 with no --save file is a run that stopped before measuring.
status=0
ir base --jobs 4 "${extra[@]}" --save "$OUT/base.json" || status=$?
if [[ ($status -ne 0 && $status -ne 3 && $status -ne 4) || ! -f $OUT/base.json ]]; then
  echo "::error::the base run failed (exit $status)"
  exit "$((status ? status : 4))"
fi
ir head --jobs 4 "${extra[@]}" --compare "$OUT/base.json" --new "$new" --report "$OUT/report.json"
