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

echo "Verified $want → https://registry.npmjs.org/"
