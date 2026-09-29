#!/usr/bin/env bash
# Regression fixtures for the runner drift guard (the awk program in the
# runner-drift-guard job of .github/workflows/ci.yml). Every `bad` fixture must
# exit 1 with a ::error line, and when it lists lines, its errors must fall on
# exactly those lines; every `good` fixture must exit 0. Each fixture also runs
# with CRLF line endings and must get the same verdict. Structural `bad`
# fixtures carry only hosted labels, so nothing but the shape under test can
# fail them. A fixture named <name>/build-native is written as
# build-native.yml. Add the shape here when you close a hole.
#
#   CI:     bash .github/scripts/runner-drift-guard-selftest.sh "$RUNNER_TEMP/runner-drift-guard.awk"
#   Local:  bash .github/scripts/runner-drift-guard-selftest.sh   (extracts the program from ci.yml)
set -u
cd "$(dirname "$0")/../.." || exit 1
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
prog=${1:-}
if [ -z "$prog" ]; then
  prog=$tmp/runner-drift-guard.awk
  sed -n "/<<'AWK'\$/,/^ *AWK\$/p" .github/workflows/ci.yml | sed '1d;$d' > "$prog"
fi
[ -s "$prog" ] || { echo "::error::guard program not found: ${prog}"; exit 1; }
fail=0

check() { # kind name body [lines]
  f=$tmp/$2.yml
  mkdir -p "${f%/*}"
  printf '%s\n' "$3" > "$f"
  for eol in LF CRLF; do
    [ "$eol" = CRLF ] && sed -i 's/$/\r/' "$f"
    out=$(awk -f "$prog" "$f" 2>&1); rc=$?
    got=$(sed -n 's/^::error file=[^,]*,line=\([0-9]*\)::.*/\1/p' <<<"$out" | sort -nu | xargs)
    case "$1" in
      bad)  [ "$rc" -eq 1 ] && [ -n "$got" ] && [ "${4:-$got}" = "$got" ] && continue ;;
      good) [ "$rc" -eq 0 ] && continue ;;
    esac
    printf '::error::selftest %s %s (%s): exit %s, error lines [%s], expected [%s]\n%s\n' \
      "$1" "$2" "$eol" "$rc" "$got" "${4:-any}" "$out"
    fail=1
  done
}
bad()  { check bad  "$@"; }
good() { check good "$@"; }

# --- label policy ----------------------------------------------------------
bad pool-label            $'jobs:\n  j:\n    runs-on: build-pool'
bad hosted-prefix-pool    $'jobs:\n  j:\n    runs-on: ubuntu-pool'
bad unlisted-hosted-arm   $'jobs:\n  j:\n    runs-on: ubuntu-24.04-arm'
bad self-hosted-list      $'jobs:\n  j:\n    runs-on: [self-hosted, linux]'
bad vars-indirection      $'jobs:\n  j:\n    runs-on: ${{ vars.RUNNER }}'
bad other-matrix-key      $'jobs:\n  j:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]'
bad matrix-os-pool        $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, build-pool]'
bad matrix-runner-pool    $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        runner: [build-pool]'
bad matrix-include-item   $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os: build-pool\n            node: 24'
bad same-indent-include   $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n        - os: build-pool'
bad quoted-key            $'jobs:\n  j:\n    "runs-on": build-pool'
bad quoted-key-os         $'jobs:\n  j:\n    strategy:\n      matrix:\n        \'os\': [build-pool]'
bad upper-key             $'jobs:\n  j:\n    strategy:\n      matrix:\n        OS: [build-pool]\n    runs-on: ${{ matrix.os }}'
bad hash-in-plain-scalar  $'jobs:\n  j:\n    runs-on: ubuntu-latest#pool'
# --- values not written inline (hosted labels: only the shape fails) --------
bad block-form            $'jobs:\n  j:\n    runs-on:\n      group: some-group\n      labels: [ubuntu-latest]'
bad block-sequence        $'jobs:\n  j:\n    runs-on:\n      - ubuntu-latest'
bad prettier-wrapped-list $'jobs:\n  j:\n    runs-on:\n      [\n        ubuntu-latest,\n      ]'
bad hand-wrapped-list     $'jobs:\n  j:\n    runs-on: [\n      ubuntu-latest]'
bad unclosed-list         $'jobs:\n  j:\n    strategy:\n      matrix:\n        os: [ubuntu-latest\n          , macos-latest]'
bad block-sequence-os     $'jobs:\n  j:\n    strategy:\n      matrix:\n        os:\n          - ubuntu-latest'
bad folded-scalar         $'jobs:\n  j:\n    runs-on: >-\n      ${{ github.event.pull_request.head.repo.fork && \'ubuntu-latest\' || \'macos-latest\' }}'
bad literal-scalar        $'jobs:\n  j:\n    runs-on: |\n      ubuntu-latest'
bad wrapped-expression    $'jobs:\n  j:\n    runs-on: ${{ github.event.pull_request.head.repo.fork &&\n      \'ubuntu-latest\' || \'macos-latest\' }}'
bad wrapped-plain-scalar  $'jobs:\n  j:\n    runs-on: ubuntu-latest\n      macos-latest' 4
bad wrapped-include-item  $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os: ubuntu-latest\n              macos-latest\n            node: 24' 7
bad hash-in-quoted-scalar $'jobs:\n  j:\n    runs-on: "ubuntu-latest #pool"'
# --- lines that may hide a runner label (hosted labels: only the shape fails)
bad flow-style-job        'jobs: {j: {runs-on: ubuntu-latest}}'
bad flow-strategy         $'jobs:\n  j:\n    strategy: {fail-fast: false, matrix: {os: [ubuntu-latest]}}'
bad flow-multiline        $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy: {matrix: {\n      os: [ubuntu-latest]}}'
bad flow-include-list     $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        include: [{ os: ubuntu-latest }]'
bad flow-include-item     $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        include:\n          - { os: ubuntu-latest, target: x }'
bad flow-runner           $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        include:\n          - { runner: ubuntu-latest }'
bad flow-env-os           $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    env: {foo: bar, os: linux}'
bad dynamic-matrix        $'jobs:\n  j:\n    strategy:\n      matrix: ${{ fromJSON(needs.p.outputs.m) }}\n    runs-on: ${{ matrix.os }}'
bad dynamic-include       $'jobs:\n  j:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include: ${{ fromJSON(vars.EXTRA) }}\n    runs-on: ${{ matrix.os }}'
bad matrix-anchor-def     $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix: &shared\n        os: [ubuntu-latest]'
bad matrix-alias          $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix: *shared'
bad matrix-tag            $'jobs:\n  j:\n    strategy:\n      matrix: !!map\n        os: [ubuntu-latest]'
bad strategy-alias        $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy: *shared'
bad include-alias         $'x: &inc\n  - os: ubuntu-latest\njobs:\n  j:\n    strategy:\n      matrix:\n        include: *inc'
bad alias-item            $'x: &item\n  os: ubuntu-latest\njobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - *item'
bad merge-key             $'jobs:\n  j:\n    strategy:\n      matrix:\n        <<: *shared'
bad external-reusable     $'jobs:\n  j:\n    uses: other-org/tooling/.github/workflows/build.yml@main'
# --- a verdict never depends on a non-runner key: each pair differs only in
# the sibling key, and both fail on the os line, never on the sibling's -----
bad os-object-list-pkg    $'jobs:\n  j:\n    strategy:\n      matrix:\n        os:\n          - runner: ubuntu-latest\n            artifact: cachekit.linux-x64-gnu.node' 5
bad os-object-list-other  $'jobs:\n  j:\n    strategy:\n      matrix:\n        os:\n          - runner: ubuntu-latest\n            artifact: other' 5
bad os-item-sequence-pkg  $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os:\n              - ubuntu-latest\n            pkg: cachekit-core-ts' 6
bad os-item-sequence-other $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os:\n              - ubuntu-latest\n            pkg: other' 6
# --- build-native.yml's dynamic matrix: accepted only in that file's build
# job, and only while every "os" its resolve job writes is a checked literal.
# native <line> is build-native.yml cut down, with <line> as the resolve job's
# push-branch assignment (line 12); the build job's include is on line 20.
resolve_job=$(cat <<'YAML'
  matrix:
    runs-on: ubuntu-latest
    outputs:
      builds: ${{ steps.set.outputs.builds }}
    steps:
      - id: set
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            builds='[{"target":"x86_64-unknown-linux-gnu","os":"ubuntu-latest"}]'
          else
            @BUILDS@
          fi
          echo "builds=$(echo "$builds" | tr -d '\n ')" >> "$GITHUB_OUTPUT"
YAML
)
build_job=$(cat <<'YAML'
  build:
    needs: matrix
    strategy:
      fail-fast: false
      matrix:
        include: ${{ fromJSON(needs.matrix.outputs.builds) }}
    runs-on: ${{ matrix.os }}
YAML
)
native() { printf 'jobs:\n%s\n%s' "${resolve_job/@BUILDS@/"$1"}" "$build_job"; }
one=$'builds=\'[{"target":"x86_64-apple-darwin","os":"macos-latest"}]\''
wrapped=$'builds=\'[\n              {"target":"x86_64-apple-darwin","os":"macos-latest"},\n              {"target":"x86_64-pc-windows-msvc", "os": "windows-latest"}\n            ]\''
good dynamic-matrix/build-native             "$(native "$wrapped")"
good dynamic-matrix-build-first/build-native "$(printf 'jobs:\n%s\n%s' "$build_job" "${resolve_job/@BUILDS@/"$one"}")"
bad json-pool-label/build-native    "$(native $'builds=\'[{"target":"x","os":"build-pool"}]\'')" 12
bad json-shell-var/build-native     "$(native $'builds=\'[{"target":"x","os":"\'"$RUNNER"\'"}]\'')" 12
bad json-escaped-var/build-native   "$(native $'builds="[{\\"target\\":\\"x\\",\\"os\\":\\"$RUNNER\\"}]"')" 12
bad json-jq-arg/build-native        "$(native $'builds=$(jq -nc --arg os "$RUNNER" \'[{target: "x", os: $os}]\')')" 12
bad json-split-pair/build-native    "$(native $'builds=\'[{"target":"x","os":\n              "macos-latest"}]\'')" 12
bad json-vars-expression/build-native "$(native $'builds=\'${{ vars.BUILD_MATRIX }}\'')" 12
bad json-file-read/build-native     "$(native $'builds=$(cat build-matrix.json)')" 12
bad json-env-variable/build-native  "$(native $'builds="$BUILD_MATRIX"')" 12
bad json-no-literal/build-native    "jobs:"$'\n  matrix:\n    runs-on: ubuntu-latest\n    outputs:\n      builds: ${{ steps.set.outputs.builds }}\n    steps:\n      - id: set\n        run: echo \'builds=[{"target":"x"}]\' >> "$GITHUB_OUTPUT"\n'"$build_job" "8 14"
bad dynamic-other-job/build-native  "$(native "$one")"$'\n'"${build_job/build:/build2:}" 27
bad dynamic-other-output/build-native "$(s=$(native "$one"); printf '%s' "${s/needs.matrix.outputs.builds/needs.matrix.outputs.extra}")" 20
bad dynamic-other-workflow          "$(native "$one")" "10 12 20"
env_step=$'        env:\n          BASH_ENV: .github/m.sh\n        run: |'
bad json-read-file/build-native     "$(native 'read -r builds < build-matrix.json')" 12
bad json-extra-output/build-native  "$(native "$one"$'\n            node scripts/gen-matrix.js >> "$GITHUB_OUTPUT"')" 13
bad json-step-env/build-native      "$(s=$(native "$one"); printf '%s' "${s/        run: |/"$env_step"}")" "8 9"
bad json-hash-in-literal/build-native "$(native $'builds=\'[{"target":"#","os":"build-pool"}]\'')" 12
bad json-hash-escaped-var/build-native "$(native $'builds="[{\\"target\\":\\"#\\",\\"os\\":\\"$RUNNER\\"}]"')" 12
bad json-hash-line-in-literal/build-native "$(native $'builds=\'[\n              # {"target":"x","os":"build-pool"}\n              {"target":"x","os":"macos-latest"}]\'')" 13
bad json-escaped-key/build-native   "$(native $'builds=\'[{"target":"x","\\u006fs":"build-pool"}]\'')" 12
bad json-name-in-run/build-native   "$(native "$one"$'\n            name: || echo "builds=$(cat build-matrix.json)" >> "$GITHUB_OUTPUT"')" 13
unclosed=$'jobs:\n  matrix:\n    runs-on: ubuntu-latest\n    outputs:\n      builds: ${{ steps.set.outputs.builds }}\n    steps:\n      - run: |\n          builds=\'[{"target":"x","os":"macos-latest"}]\n        continue-on-error: true\n      - id: set\n        uses: some-org/matrix-action@v1\n'
bad json-unclosed-literal/build-native "$unclosed$build_job" "9 11"
yaml_comments=$(s=$(native "$one"); s=${s/    runs-on: ubuntu-latest/    runs-on: ubuntu-latest  # hosted}; s=${s/    outputs:/    outputs:  # read by build}
  s=${s/      - id: set/      - id: set  # step}; printf '%s' "${s/        run: |/        run: |  # PRs: linux only}")
good resolve-yaml-comments/build-native "$yaml_comments"
bad json-run-in-name/build-native   "${unclosed/      - run: |/      - name: x run: |}$build_job" "8 9 11 17"
good resolve-job-comments/build-native "$(native $'# don\'t read this list from a file\n            '"$one")"
# --- must pass --------------------------------------------------------------
good ubuntu-latest        $'jobs:\n  j:\n    runs-on: ubuntu-latest'
good upper-hosted-label   $'jobs:\n  j:\n    runs-on: Ubuntu-Latest'
good comment-stripped     $'jobs:\n  j:\n    runs-on: ubuntu-latest  # was: build-pool'
good comment-after-quoted $'jobs:\n  j:\n    runs-on: \'ubuntu-latest\'  # it\'s pinned'
good quoted-matrix-os     $'jobs:\n  j:\n    runs-on: "${{ matrix.os }}"'
good inline-matrix        $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest, \'windows-latest\']\n        node: [22, 24]'
good include-item         $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os: windows-latest\n            node: 24'
good matrix-runner-hosted $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        runner: [ubuntu-latest, macos-latest]'
good dispatch-input-os    $'on:\n  workflow_dispatch:\n    inputs:\n      os:\n        description: Target for cachekit-core-ts\n        type: choice\n        options: [linux, mac]\njobs:\n  j:\n    runs-on: ubuntu-latest'
good action-with-os       $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action@abc\n        with:\n          os: linux'
good action-with-include  $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action@abc\n        with:\n          include: docs/**'
good concurrency-group    $'concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  j:\n    runs-on: ubuntu-latest\n    concurrency:\n      group: build-${{ github.ref }}'
good os-after-matrix-end  $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n    env:\n      os: linux'
good local-reusable       $'jobs:\n  j:\n    uses: ./.github/workflows/x.yml'
good script-string        $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "runs-on: build-pool is banned"'
good markdown-bullets     $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "* item" >> "$GITHUB_STEP_SUMMARY"\n          echo "- **bold** item" >> "$GITHUB_STEP_SUMMARY"'
good job-anchor           $'jobs:\n  a: &job\n    runs-on: ubuntu-latest\n  b: *job'

if [ "$fail" -ne 0 ]; then echo "runner-drift-guard selftest FAILED"; exit 1; fi
echo "runner-drift-guard selftest OK ($(grep -c '^bad ' "$0") bad, $(grep -c '^good ' "$0") good, each also as CRLF)"
