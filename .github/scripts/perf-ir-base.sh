#!/usr/bin/env bash
# Pick the commit the instruction-count gate measures a pull request against,
# and write it to $GITHUB_OUTPUT as `sha` (what to build), `package` (empty, or
# the one package the base takes from `sha`) and `label` (how the comment names
# it). Run from a checkout of the PR merge commit with its first parent.
#
# A feature PR is measured against its base, the merge commit's first parent.
# A release PR (head branch release-please--branches--main--components--<c>)
# is rebased onto main on every push, so against main it would measure only a
# version bump. It is measured against that package's last release instead:
# tag <c>-v<version>, where <version> is the package's entry in the base's
# .release-please-manifest.json. A tag that cannot be fetched fails the job; it
# never falls back to main, which would read PASS without measuring anything.
#
# The SDK's release (packages/cachekit) is measured against the whole tagged
# tree, so its comment shows every workload's drift since that release. A
# core's release ships only that core's package, so its base is the PR's own
# tree with only that package taken from the tag (perf-ir.sh trees): every
# workload, the SDK ones that run through the core included, then measures the
# core's drift alone. SDK drift since the core's tag is the SDK's own release's
# to gate, against the SDK's tag. Anyone can name a branch, so a PR gets that
# base only when it changes nothing outside the core's package and the
# manifest; any other PR on such a branch gets the whole tagged tree.
#
#   CI:    HEAD_REF=${{ github.head_ref }} bash .github/scripts/perf-ir-base.sh
#   Local: HEAD_REF=release-please--branches--main--components--cachekit \
#            GITHUB_OUTPUT=/dev/stdout bash .github/scripts/perf-ir-base.sh
set -euo pipefail

package=
if [[ ${HEAD_REF:-} != release-please--*--components--* ]]; then
  sha=$(git rev-parse HEAD^1)
  label=$sha
else
  component=${HEAD_REF##*--components--}
  path=$(git show HEAD^1:release-please-config.json |
    jq -er --arg c "$component" '.packages | to_entries[] | select(.value.component == $c) | .key') || {
    echo "::error::release PR: no package with component \"$component\" in the base's release-please-config.json"
    exit 1
  }
  version=$(git show HEAD^1:.release-please-manifest.json | jq -er --arg p "$path" '.[$p]') || {
    echo "::error::release PR: no \"$path\" version in the base's .release-please-manifest.json"
    exit 1
  }
  tag=$component-v$version
  git fetch --quiet --no-tags --depth=1 origin "refs/tags/$tag:refs/tags/$tag" || {
    echo "::error::release PR: cannot fetch the last release tag $tag"
    exit 1
  }
  sha=$(git rev-parse "$tag^{commit}")
  label="$tag ($(git rev-parse --short=7 "$sha")), last release"
  outside=$(git diff --name-only HEAD^1 HEAD -- . ":!$path/" ':!.release-please-manifest.json')
  if [[ $path != packages/cachekit && -z $outside ]]; then
    package=$path
    label="this PR with $path at $label"
  elif [[ $path != packages/cachekit ]]; then
    echo "::notice::release PR changes files outside $path, so it is measured against the whole $tag tree"
  fi
fi
echo "Base: $label"
{
  echo "sha=$sha"
  echo "package=$package"
  echo "label=$label"
} >> "$GITHUB_OUTPUT"
