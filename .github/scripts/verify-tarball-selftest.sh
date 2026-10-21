#!/usr/bin/env bash
# Regression fixtures for verify-tarball.sh's dependency and manifest checks.
# Each fixture packs a tarball, pins its sha256, and runs the real verifier
# against registry.npmjs.org. Every `bad` fixture must exit 1 with exactly the
# given number of ::error lines, each holding the given text. Every `good`
# fixture must exit 0. Add the shape here when you close a hole.
#
#   bash .github/scripts/verify-tarball-selftest.sh   (needs pnpm, node, jq, npm, network)
set -u
cd "$(dirname "$0")/../.." || exit 1
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
fail=0
id='"name":"@cachekit-io/cachekit","version":"0.0.0-selftest"'
printf '{%s}\n' "$id" > "$tmp/package.json"

manifest() { # deps-json: a package.json body with these dependencies
  printf '{%s,"dependencies":%s}\n' "$id" "$1"
}
pack() { # name [path deps-json]...: entries in order, written to $tmp/<name>.tgz
  local name=$1 n=0
  shift
  : > "$tmp/$name.tar"
  while [ "$#" -ge 2 ]; do
    n=$((n + 1))
    mkdir -p "$(dirname "$tmp/$name.$n/$1")" && manifest "$2" > "$tmp/$name.$n/$1" || exit 1
    tar -rf "$tmp/$name.tar" -C "$tmp/$name.$n" "$1" || exit 1
    shift 2
  done
  gzip -c "$tmp/$name.tar" > "$tmp/$name.tgz" || exit 1
}
run() { # kind name errors text [env...]
  local kind=$1 name=$2 errors=$3 text=$4 sha
  shift 4
  sha=$(sha256sum "$tmp/$name.tgz" | cut -d' ' -f1)
  out=$(env "$@" bash .github/scripts/verify-tarball.sh "$tmp/$name.tgz" "$tmp/package.json" "$sha" 2>&1)
  rc=$?
  got=$(grep -c '^::error' <<<"$out")
  case "$kind" in
    bad) [ "$rc" -eq 1 ] && [ "$got" -eq "$errors" ] && ! grep '^::error' <<<"$out" | grep -qvF -- "$text" && return 0 ;;
    good) [ "$rc" -eq 0 ] && [ "$got" -eq 0 ] && return 0 ;;
  esac
  printf '::error::selftest %s %s: exit %s, %s error lines, expected %s holding "%s"\n%s\n' \
    "$kind" "$name" "$rc" "$got" "$errors" "$text" "$out"
  fail=1
}
bad() { run bad "$@"; }
good() { run good "$1" 0 '' "${@:2}"; }

nothing='no published version'
# --- dependencies must resolve on the registry -------------------------------
pack unpublished package/package.json '{"@cachekit-io/cachekit-core-ts":"0.1.3","@msgpack/msgpack":"^3.1.3"}'
bad unpublished 1 "'@cachekit-io/cachekit-core-ts@0.1.3' resolves to $nothing"
pack published package/package.json '{"@cachekit-io/cachekit-core-ts":"0.1.2","@msgpack/msgpack":"^3.1.3"}'
good published
pack two-unpublished package/package.json '{"@cachekit-io/cachekit-core-ts":"0.1.3","@cachekit-io/cachekit-core-wasm":"99.0.0","@msgpack/msgpack":"^3.1.3"}'
bad two-unpublished 2 "$nothing"
pack no-such-package package/package.json '{"@cachekit-io/no-such-package-selftest":"1.0.0"}'
bad no-such-package 1 "$nothing"
pack no-deps package/package.json '{}'
good no-deps
# A lookup that cannot reach the registry refuses: an empty cache, offline.
bad published 2 'lookup on https://registry.npmjs.org/ failed (ENOTCACHED)' \
  npm_config_offline=true npm_config_cache="$tmp/empty-cache"
# --- only registry specs are looked up: npm would fetch the rest -------------
pack git-spec package/package.json '{"x":"github:cachekit-io/cachekit-ts"}'
bad git-spec 1 'is not a registry name@range'
pack path-spec package/package.json '{"x":"../x"}'
bad path-spec 1 'is not a registry name@range'
pack bad-deps package/package.json '{"x":{"version":"1.0.0"}}'
bad bad-deps 1 'not a name → version map'
# --- the manifest checked is the one pnpm publishes --------------------------
# pnpm reads the first entry that normalises to package/package.json; a raw tar
# read of package/package.json would see the second.
pack decoy-dot ./package/package.json '{"@cachekit-io/cachekit-core-ts":"0.1.3"}' package/package.json '{}'
bad decoy-dot 1 'expected exactly'
pack decoy-after package/package.json '{}' package//package.json '{"@cachekit-io/cachekit-core-ts":"0.1.3"}'
bad decoy-after 1 'expected exactly'
# pnpm makes a backslash a slash; GNU tar lists it as two.
pack decoy-backslash 'package\package.json' '{"@cachekit-io/cachekit-core-ts":"0.1.3"}' package/package.json '{}'
bad decoy-backslash 1 'expected exactly'

if [ "$fail" -ne 0 ]; then echo "verify-tarball selftest FAILED"; exit 1; fi
echo "verify-tarball selftest OK ($(grep -cE '^(bad|good) ' "$0") fixtures)"
