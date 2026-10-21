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
    tar --format=ustar -rf "$tmp/$name.tar" -C "$tmp/$name.$n" "$1" || exit 1
    shift 2
  done
  gzip -c "$tmp/$name.tar" > "$tmp/$name.tgz" || exit 1
}
# shellcheck disable=SC2016 # the single-quoted program is JavaScript
raw() { # name [type path body]...: hand-built USTAR headers, for entry types tar will not write
  node -e '
    const [out, ...spec] = process.argv.slice(1);
    const entry = (type, name, body) => {
      if (type === "g" || type === "x") { // one pax record: "<len> key=value\n"
        let n = body.length + 3;
        while (String(n).length + body.length + 2 !== n) n = String(n).length + body.length + 2;
        body = `${n} ${body}\n`;
      }
      body = Buffer.from(body);
      const h = Buffer.alloc(512);
      h.write(name, 0, 100);
      for (const [at, v] of [[100, "0000644"], [108, "0000000"], [116, "0000000"]]) h.write(v + " ", at, "latin1");
      h.write(body.length.toString(8).padStart(11, "0") + " 00000000000 ", 124, "latin1");
      h.write(" ".repeat(8) + type, 148, "latin1");
      h.write("ustar\x0000", 257, "latin1");
      h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
      return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
    };
    const blocks = [];
    for (let i = 0; i < spec.length; i += 3) blocks.push(entry(...spec.slice(i, i + 3)));
    blocks.push(Buffer.alloc(1024));
    require("node:fs").writeFileSync(out, require("node:zlib").gzipSync(Buffer.concat(blocks)));
  ' "$tmp/$1.tgz" "${@:2}" || exit 1
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
# Never on npm, whatever is released later (0.1.3, the version cachekit 0.2.0
# pinned, may yet be published to repair it).
never=0.0.0-never-published
clean=$(manifest '{}')
evil=$(manifest '{"@cachekit-io/cachekit-core-ts":"'$never'"}')
# --- dependencies must resolve on the registry -------------------------------
pack unpublished package/package.json '{"@cachekit-io/cachekit-core-ts":"'$never'","@msgpack/msgpack":"^3.1.3"}'
bad unpublished 1 "'@cachekit-io/cachekit-core-ts@$never' resolves to $nothing"
pack published package/package.json '{"@cachekit-io/cachekit-core-ts":"0.1.2","@msgpack/msgpack":"^3.1.3"}'
good published
pack two-unpublished package/package.json '{"@cachekit-io/cachekit-core-ts":"'$never'","@cachekit-io/cachekit-core-wasm":"99.0.0","@msgpack/msgpack":"^3.1.3"}'
bad two-unpublished 2 "$nothing"
pack no-such-package package/package.json '{"@cachekit-io/no-such-package-selftest":"1.0.0"}'
bad no-such-package 1 "$nothing"
pack no-deps package/package.json '{}'
good no-deps
pack null-deps package/package.json 'null'
good null-deps
# A lookup that cannot reach the registry refuses: an empty cache, offline.
bad published 2 'lookup on https://registry.npmjs.org/ failed (ENOTCACHED)' \
  npm_config_offline=true npm_config_cache="$tmp/empty-cache"
# --- only registry specs are looked up: npm would fetch the rest -------------
pack git-spec package/package.json '{"x":"github:cachekit-io/cachekit-ts"}'
bad git-spec 1 'is not a registry name@range'
pack path-spec package/package.json '{"x":"../x"}'
bad path-spec 1 'is not a registry name@range'
# --- dependencies must be a map of non-empty names to version strings -------
pack object-spec package/package.json '{"x":{"version":"1.0.0"}}'
bad object-spec 1 'not a map of names to version strings'
pack number-spec package/package.json '{"@msgpack/msgpack":3}'
bad number-spec 1 'not a map of names to version strings'
pack array-deps package/package.json '["0.0.0"]'
bad array-deps 1 'not a map of names to version strings'
pack empty-name package/package.json '{"":""}'
bad empty-name 1 'not a map of names to version strings'
pack empty-spec package/package.json '{"@msgpack/msgpack":""}'
bad empty-spec 1 'not a map of names to version strings'
# --- the manifest checked is the one pnpm publishes --------------------------
# pnpm reads the first entry that normalises to package/package.json; a raw tar
# read of package/package.json would see the second. Every name must be
# canonical, so each of these is refused at the decoy.
pack decoy-dot ./package/package.json '{"@cachekit-io/cachekit-core-ts":"'$never'"}' package/package.json '{}'
bad decoy-dot 1 'non-canonical entry name'
pack decoy-after package/package.json '{}' package//package.json '{"@cachekit-io/cachekit-core-ts":"'$never'"}'
bad decoy-after 1 'non-canonical entry name'
# pnpm makes a backslash a slash after normalising, so a\b is one segment to
# path.normalize and a\b/../package/package.json reads as package/package.json.
pack decoy-backslash 'package\package.json' '{"@cachekit-io/cachekit-core-ts":"'$never'"}' package/package.json '{}'
bad decoy-backslash 1 'non-canonical entry name'
raw decoy-backslash-dotdot 0 'a\b/../package/package.json' "$evil" 0 package/package.json "$clean"
bad decoy-backslash-dotdot 1 'non-canonical entry name'
raw two-manifests 0 package/package.json "$evil" 0 package/package.json "$clean"
bad two-manifests 1 'expected exactly 1'
# GNU tar applies a pax global header's path to the next entry; tar-stream,
# which pnpm uses, does not, so the two read different manifests.
raw decoy-pax-global g pax_global_header 'path=package/decoy.json' 0 package/package.json "$evil" \
  x pax_header 'path=package/package.json' 0 package/clean.json "$clean"
bad decoy-pax-global 1 "entry of type 'g'"
raw pax-header x pax_header 'path=package/package.json' 0 package/x.json "$clean"
bad pax-header 1 "entry of type 'x'"
raw gnu-long-name L ././@LongLink package/package.json 0 package/x.json "$clean"
bad gnu-long-name 1 "entry of type 'L'"
raw symlink 2 package/link '' 0 package/package.json "$clean"
bad symlink 1 "entry of type '2'"
# tar-stream reads no data for a directory, where packed-manifest.mjs would
# skip it. pnpm then publishes nothing, so this one runs the reader alone.
raw directory-with-data 5 package/ "$clean" 0 package/package.json "$clean"
out=$(node .github/scripts/packed-manifest.mjs "$tmp/directory-with-data.tgz" 2>&1)
rc=$?
if [ "$rc" -ne 1 ] || ! grep -q '^::error::.*directory with data' <<<"$out"; then
  printf '::error::selftest reader directory-with-data: exit %s\n%s\n' "$rc" "$out"
  fail=1
fi
raw hand-built 0 package/package.json "$clean"
good hand-built
# GNU tar's own format marks its headers "ustar  ", which tar-stream reads
# without the USTAR prefix field.
mkdir -p "$tmp/gnu/package" && printf '%s\n' "$clean" > "$tmp/gnu/package/package.json" &&
  tar --format=gnu -czf "$tmp/gnu-format.tgz" -C "$tmp/gnu" package/package.json || exit 1
bad gnu-format 1 'non-USTAR header'

if [ "$fail" -ne 0 ]; then echo "verify-tarball selftest FAILED"; exit 1; fi
echo "verify-tarball selftest OK ($(grep -cE '^(bad|good) ' "$0") fixtures)"
