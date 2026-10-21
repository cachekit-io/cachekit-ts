#!/usr/bin/env bash
# Refuse a release tarball unless it is exactly what its build job packed, for
# the package being released, bound for registry.npmjs.org.
#
# Usage: verify-tarball.sh <tarball> <package.json> <sha256>
#
# The tarball comes from a job that ran dependency code, so nothing about it is
# trusted until checked here:
# - sha256 against the build job's output: any job in the run can replace an
#   artifact by name, none can rewrite another job's outputs.
# - name@version as pnpm reads it (`--dry-run --json`), not tar: pnpm takes the
#   first entry that normalises to package/package.json, so a `./package/...`
#   entry ahead of the real one would show tar a decoy manifest.
# - registry as pnpm resolves it: a tarball's publishConfig.registry beats
#   every other registry setting.
# - every `dependencies` entry resolves to a published version on
#   registry.npmjs.org: pnpm pack writes workspace:* as the sibling's version on
#   disk, which nothing else compares with the registry, and a release pinning
#   an unpublished one moves `latest` to a package no one can install. A failed
#   lookup refuses too. The manifest read is the one pnpm publishes: tar is
#   asked for it by its literal name only after no other entry normalises, as
#   pnpm normalises, to package/package.json, and what tar returns must carry
#   the name@version pnpm reported.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: verify-tarball.sh <tarball> <package.json> <sha256>" >&2
  exit 2
fi

tarball=$1 manifest=$2 sha256=$3

if [ ! -f "$tarball" ]; then
  echo "::error::Tarball '$tarball' does not exist." >&2
  exit 2
fi

if [ ! -f "$manifest" ]; then
  echo "::error::Manifest '$manifest' does not exist." >&2
  exit 2
fi

if [[ ! $sha256 =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::sha256 '$sha256' is not 64 lowercase hex characters." >&2
  exit 2
fi

echo "$sha256  $tarball" | sha256sum -c -

want=$(jq -r '.name + "@" + .version' "$manifest")

# A dry run still attempts the OIDC token exchange — against whatever registry
# the tarball names — so run it without the token-request env.
dry() {
  env -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL \
    pnpm publish "$tarball" --dry-run --access public --no-git-checks "$@"
}

got=$(dry --json | jq -r .id)
if [ "$got" != "$want" ]; then
  echo "::error::Tarball is '$got', expected '$want' — refusing to publish."
  exit 1
fi

# Name and version are now exact, so the only free part of pnpm's
# "📦 <name>@<version> → <registry>" line is the registry.
target=$(dry 2>&1 | grep '^📦 ' || true)
if [ "$target" != "📦 $want → https://registry.npmjs.org/" ]; then
  echo "::error::Tarball targets '${target#📦 }', expected '$want → https://registry.npmjs.org/' — refusing to publish."
  exit 1
fi

# pnpm reads the first entry whose path.normalize(name), with backslashes then
# made slashes, is package/package.json, and reads past zero blocks (hence
# --ignore-zeros). Making the slashes first matches every name pnpm would, and
# more; GNU tar lists a backslash as two, which normalise to one.
entries=$(tar --ignore-zeros -tzf "$tarball" | node -e '
  const { normalize } = require("node:path");
  for (const n of require("node:fs").readFileSync(0, "utf8").split("\n"))
    if (normalize(n.replaceAll("\\", "/")) === "package/package.json") console.log(n);
')
if [ "$entries" != package/package.json ]; then
  echo "::error::Tarball entries that pnpm may read as package/package.json: '$(tr '\n' ' ' <<<"$entries")' — expected exactly 'package/package.json', refusing to publish."
  exit 1
fi
packed=$(tar --ignore-zeros -xOzf "$tarball" package/package.json)
if [ "$(jq -r '.name + "@" + .version' <<<"$packed")" != "$want" ]; then
  echo "::error::package/package.json read from the tarball is not '$want' — refusing to publish."
  exit 1
fi

deps=$(jq -r '.dependencies // {} | to_entries[] | [.key, .value] | @tsv' <<<"$packed") || {
  echo "::error::Tarball dependencies are not a name → version map — refusing to publish."
  exit 1
}
# Registry name@range only: a git, URL or path spec would make npm fetch, and
# maybe build, code from outside the registry.
name_re='^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$'
spec_re='^[0-9A-Za-z^~<>=*][0-9A-Za-z.^~<>=|*+ -]*$'
err=$(mktemp)
trap 'rm -f "$err"' EXIT
refused=0
while IFS=$'\t' read -r name spec; do
  [ -n "$name" ] || continue
  dep="$name@$spec"
  if [[ ! $name =~ $name_re || ! $spec =~ $spec_re ]]; then
    echo "::error::Dependency '$dep' is not a registry name@range — refusing to publish."
    refused=1
    continue
  fi
  rc=0
  found=$(npm view --registry=https://registry.npmjs.org/ --prefer-online -- "$dep" version 2>"$err") || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$found" ]; then continue; fi
  code=$(sed -n 's/^npm error code //p' "$err" | head -1)
  if [ "$code" = E404 ] || [ "$rc" -eq 0 ]; then
    echo "::error::Dependency '$dep' resolves to no published version on https://registry.npmjs.org/ — refusing to publish."
  else
    echo "::error::Dependency '$dep' lookup on https://registry.npmjs.org/ failed (${code:-exit $rc}) — refusing to publish."
  fi
  refused=1
done <<<"$deps"
if [ "$refused" -ne 0 ]; then exit 1; fi

echo "Verified $want → https://registry.npmjs.org/"
