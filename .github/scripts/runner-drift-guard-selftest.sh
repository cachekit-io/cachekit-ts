#!/usr/bin/env bash
# Regression fixtures for the runner drift guard (the awk program and the scan
# driver in the runner-drift-guard job of .github/workflows/ci.yml). Every `bad`
# fixture must exit 1 with ::error lines; when it lists lines, its errors must
# fall on exactly those lines, and when it gives text, every error must hold it.
# Every `good` fixture must exit 0. Each program fixture also runs with CRLF
# line endings and must get the same verdict. Structural `bad` fixtures carry
# only hosted labels, so nothing but the shape under test can fail them. Add
# the shape here when you close a hole.
#
#   CI:     bash .github/scripts/runner-drift-guard-selftest.sh "$RUNNER_TEMP/runner-drift-guard.awk" "$RUNNER_TEMP/runner-drift-guard-scan.sh"
#   Local:  bash .github/scripts/runner-drift-guard-selftest.sh   (extracts both from ci.yml)
set -u
cd "$(dirname "$0")/../.." || exit 1
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
extract() { sed -n "/<<'$1'\$/,/^ *$1\$/p" .github/workflows/ci.yml | sed '1d;$d'; }
prog=${1:-}
scan=${2:-}
if [ -z "$prog" ]; then prog=$tmp/runner-drift-guard.awk; extract AWK > "$prog"; fi
if [ -z "$scan" ]; then scan=$tmp/runner-drift-guard-scan.sh; extract SCAN > "$scan"; fi
[ -s "$prog" ] || { echo "::error::guard program not found: ${prog}"; exit 1; }
[ -s "$scan" ] || { echo "::error::guard scan driver not found: ${scan}"; exit 1; }
fail=0

verdict() { # kind name [lines] [text], judging $rc and $out
  got=$(sed -n 's/^::error file=[^,]*,line=\([0-9]*\)::.*/\1/p' <<<"$out" | sort -nu | xargs)
  case "$1" in
    bad)  [ "$rc" -eq 1 ] && grep -q '^::error' <<<"$out" && [ "${3:-$got}" = "$got" ] &&
            ! grep '^::error' <<<"$out" | grep -qvF -- "${4:-::error}" && return 0 ;;
    good) [ "$rc" -eq 0 ] && return 0 ;;
  esac
  printf '::error::selftest %s %s: exit %s, error lines [%s], expected [%s]%s\n%s\n' \
    "$1" "$2" "$rc" "$got" "${3:-any}" "${4:+, each holding \"$4\"}" "$out"
  return 1
}
check() { # kind name body [lines] [text]
  f=$tmp/$2.yml
  printf '%s\n' "$3" > "$f"
  for eol in LF CRLF; do
    # awk, not sed -i: BSD sed reads -i's next word as a backup suffix.
    if [ "$eol" = CRLF ] && ! { awk '{ printf "%s\r\n", $0 }' "$f" > "$f.crlf" && mv "$f.crlf" "$f"; }; then
      echo "::error::selftest $1 $2: cannot write the CRLF fixture"; exit 1
    fi
    out=$(awk -f "$prog" "$f" 2>&1); rc=$?
    verdict "$1" "$2 ($eol)" "${4:-}" "${5:-}" || fail=1
  done
}
bad()  { check bad  "$@"; }
good() { check good "$@"; }

# --- label policy ----------------------------------------------------------
bad pool-label            $'jobs:\n  j:\n    runs-on: build-pool' 3 'to HOSTED'
bad hosted-prefix-pool    $'jobs:\n  j:\n    runs-on: ubuntu-pool'
bad unlisted-hosted-arm   $'jobs:\n  j:\n    runs-on: ubuntu-24.04-arm'
bad self-hosted-list      $'jobs:\n  j:\n    runs-on: [self-hosted, linux]'
bad vars-indirection      $'jobs:\n  j:\n    runs-on: ${{ vars.RUNNER }}' 3 'not a plain label'
bad matrix-os-or          $'jobs:\n  j:\n    runs-on: ${{ matrix.os || \'build-pool\' }}' 3
bad other-matrix-key      $'jobs:\n  j:\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [ubuntu-latest]' 3 'not a plain label'
bad matrix-os-pool        $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, build-pool]'
bad matrix-runner-pool    $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        runner: [build-pool]'
bad matrix-include-item   $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os: build-pool\n            node: 24'
bad same-indent-include   $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n        - os: build-pool'
bad quoted-key            $'jobs:\n  j:\n    "runs-on": build-pool'
bad quoted-key-os         $'jobs:\n  j:\n    strategy:\n      matrix:\n        \'os\': [build-pool]'
bad upper-key             $'jobs:\n  j:\n    strategy:\n      matrix:\n        OS: [build-pool]\n    runs-on: ${{ matrix.os }}'
bad hash-in-plain-scalar  $'jobs:\n  j:\n    runs-on: ubuntu-latest#pool'
# --- values not written inline (hosted labels: only the shape fails) --------
bad block-form            $'jobs:\n  j:\n    runs-on:\n      group: some-group\n      labels: [ubuntu-latest]' 3 'not whole on this line'
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
bad hash-in-quoted-scalar $'jobs:\n  j:\n    runs-on: "ubuntu-latest #pool"' 3 'not whole on this line'
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
bad next-line-matrix      $'jobs:\n  j:\n    strategy:\n      matrix:\n        ${{ fromJSON(needs.p.outputs.m) }}\n    runs-on: ${{ matrix.os }}' 5
bad next-line-include     $'jobs:\n  j:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          ${{ fromJSON(vars.EXTRA) }}\n    runs-on: ${{ matrix.os }}' 7
bad next-line-strategy    $'jobs:\n  j:\n    strategy:\n      "${{ fromJSON(vars.STRATEGY) }}"\n    runs-on: ${{ matrix.os }}' 4
bad include-expression-item $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os: ubuntu-latest\n          - ${{ fromJSON(vars.EXTRA) }}\n    runs-on: ${{ matrix.os }}' 7
bad matrix-axis-matrix    $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        matrix:\n          - a\n        os: [build-pool]' 8
bad next-line-include-flow $'jobs:\n  j:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          ["${{ fromJSON(vars.EXTRA) }}"]\n    runs-on: ${{ matrix.os }}' 7
bad next-line-matrix-anchor $'jobs:\n  j:\n    strategy:\n      matrix:\n        &m ${{ fromJSON(needs.p.outputs.m) }}\n    runs-on: ${{ matrix.os }}' 5
bad next-line-matrix-tag  $'jobs:\n  j:\n    strategy:\n      matrix:\n        !!str ${{ fromJSON(vars.X) }}\n    runs-on: ${{ matrix.os }}' 5
bad strategy-key-expressions $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      fail-fast: ${{ github.event_name == \'push\' }}\n      matrix:\n        os: [ubuntu-latest]\n        node: ${{ fromJSON(vars.NODES) }}' "5 8"
bad flow-include-hash-name $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - {name: "Node #24", os: build-pool}\n    runs-on: ${{ matrix.os }}' 6
bad flow-job-hash-name    $'jobs:\n  j: {name: " #", runs-on: build-pool, steps: [{run: echo}]}' 2
bad next-line-include-hash $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          [{name: " #"}, "${{ fromJSON(vars.EXTRA) }}"]\n    runs-on: ${{ matrix.os }}' 6
bad matrix-anchor-def     $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix: &shared\n        os: [ubuntu-latest]'
bad matrix-alias          $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix: *shared'
bad matrix-tag            $'jobs:\n  j:\n    strategy:\n      matrix: !!map\n        os: [ubuntu-latest]'
bad strategy-alias        $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy: *shared'
bad include-alias         $'x: &inc\n  - os: ubuntu-latest\njobs:\n  j:\n    strategy:\n      matrix:\n        include: *inc'
bad alias-item            $'x: &item\n  os: ubuntu-latest\njobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - *item'
bad merge-key             $'jobs:\n  j:\n    strategy:\n      matrix:\n        <<: *shared'
bad external-reusable     $'jobs:\n  j:\n    uses: other-org/tooling/.github/workflows/build.yml@main'
bad external-reusable-quoted-key $'jobs:\n  j:\n    "uses": other-org/tooling/.github/workflows/build.yml@main' 3
bad external-reusable-next-line $'jobs:\n  j:\n    uses:\n      other-org/tooling/.github/workflows/build.yml@main' 3
bad external-reusable-folded $'jobs:\n  j:\n    uses: >-\n      other-org/tooling/.github/workflows/build.yml@main' 3
bad external-reusable-literal $'jobs:\n  j:\n    uses: |-\n      other-org/tooling/.github/workflows/build.yml@main' 3
bad external-reusable-flow-job $'jobs:\n  j: {uses: other-org/tooling/.github/workflows/build.yml@main}' 2
bad external-reusable-open-quote $'jobs:\n  j:\n    uses: "other-org/tooling/\\\n      .github/workflows/build.yml@main"' 3
bad external-reusable-alias $'x: &w other-org/tooling/.github/workflows/build.yml@main\njobs:\n  j:\n    uses: *w' 4
# --- a verdict never depends on a non-runner key: each pair differs only in
# the sibling key, and both fail on the os line, never on the sibling's -----
bad os-object-list-pkg    $'jobs:\n  j:\n    strategy:\n      matrix:\n        os:\n          - runner: ubuntu-latest\n            artifact: cachekit.linux-x64-gnu.node' 5
bad os-object-list-other  $'jobs:\n  j:\n    strategy:\n      matrix:\n        os:\n          - runner: ubuntu-latest\n            artifact: other' 5
bad os-item-sequence-pkg  $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os:\n              - ubuntu-latest\n            pkg: cachekit-core-ts' 6
bad os-item-sequence-other $'jobs:\n  j:\n    strategy:\n      matrix:\n        include:\n          - os:\n              - ubuntu-latest\n            pkg: other' 6
# --- a matrix read from another job's output fails like any expression-set
# matrix, in build-native.yml too
bad build-native          $'jobs:\n  build:\n    needs: matrix\n    strategy:\n      fail-fast: false\n      matrix:\n        include: ${{ fromJSON(needs.matrix.outputs.builds) }}\n    runs-on: ${{ matrix.os }}' 7
# --- HOSTED is a set of exact labels: one that contains or extends a hosted
# label fails, with the advice to add it to HOSTED
bad hosted-label-suffix   $'jobs:\n  j:\n    runs-on: ubuntu-latest-x' 3 'to HOSTED'
bad hosted-label-prefix   $'jobs:\n  j:\n    runs-on: my-ubuntu-latest' 3 'to HOSTED'
bad matrix-hosted-suffix  $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [macos-latest, ubuntu-latest-x]' 6 'to HOSTED'
# --- a line that continues a flow collection or quoted scalar left open inside
# a strategy block ends no block, however far it is dedented
bad open-flow-list-dedent $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        foo: [a,\n    b]\n        os: [self-hosted]' 8
bad open-single-quote-dedent $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        foo: \'a\n    b\'\n        os: [self-hosted]' 8
bad open-double-quote-dedent $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        foo: "a\n    b"\n        os: [self-hosted]' 8
bad open-flow-map-dedent  $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        foo: {a: 1,\n    b: 2}\n        os: [self-hosted]' 8
bad open-anchored-flow-dedent $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        foo: &x [a,\n    b]\n        os: [self-hosted]' 8
# a job written as a flow map, its strategy: and matrix: on lines of their own
bad flow-job-strategy     $'jobs:\n  build: {\n     strategy:\n   {\n     matrix:\n   {\n     os: [self-hosted]\n   }\n   },\n   steps: [{run: echo hi}],\n   runs-on: "${{ matrix.os }}"\n   }' "4 6 7 11"
bad flow-job-dynamic-matrix $'jobs:\n  build: {\n     strategy:\n   {\n     matrix:\n   "${{ fromJSON(vars.M) }}"\n   },\n   steps: [{run: echo hi}],\n   runs-on: "${{ matrix.os }}"\n   }' "4 6 9"
bad flow-job-deeper-brace $'jobs:\n  build: {\n     strategy:\n       {\n     matrix:\n       {\n     os: [self-hosted]\n       }\n       },\n     steps: [{run: echo hi}],\n     runs-on: "${{ matrix.os }}"\n     }' "7 8 11"
# --- block-scalar text is a string: it arms nothing and opens no quote, and a
# | or > header inside a quoted scalar opens no block
bad block-text-arms-matrix $'jobs:\n  b:\n    steps:\n      - run: |\n          cat >> "$GITHUB_STEP_SUMMARY" <<\'EOF2\'\n          Matrix:\n            \'tis built\n          EOF2\n    strategy:\n      matrix:\n        note: [it\'s]\n        os: [self-hosted]\n    runs-on: ${{ matrix.os }}' 12
bad block-text-arms-strategy $'jobs:\n  b:\n    steps:\n      - run: |\n          Strategy:\n          Matrix:\n            \'tis built\n    strategy:\n      matrix:\n        note: [it\'s]\n        os: [ubuntu-latest]\n        include: ${{ fromJSON(vars.EXTRA) }}\n    runs-on: ${{ matrix.os }}' 12
bad quoted-text-block-header $'jobs:\n  j:\n    name: \'foo\n  x: |\n    \'\n    runs-on: self-hosted' 6
bad quoted-text-block-header-matrix $'jobs:\n  j:\n    name: \'foo\n  x: |\n    \'\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [self-hosted]' 9
bad include-block-scalar-item $'jobs:\n  j:\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          - |-\n              ${{ fromJSON(vars.EXTRA) }}\n    runs-on: ${{ matrix.os }}' 7 'block scalar'
bad first-unlisted-label  $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [macos-latest, self-hosted, ubuntu-latest]' 6 'runner value "self-hosted" is not an allow-listed'
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
good same-repo-reusable   $'jobs:\n  j:\n    uses: $/.github/workflows/x.yml'
good script-string        $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "runs-on: build-pool is banned"'
good markdown-bullets     $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "* item" >> "$GITHUB_STEP_SUMMARY"\n          echo "- **bold** item" >> "$GITHUB_STEP_SUMMARY"'
good job-anchor           $'jobs:\n  a: &job\n    runs-on: ubuntu-latest\n  b: *job'
good job-named-matrix     $'jobs:\n  matrix:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${{ github.workspace }}/build.sh\n  strategy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${{ github.workspace }}/check.sh'
good with-matrix-expression $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action@abc\n        with:\n          matrix:\n            ${{ vars.CONFIG }}'
good quoted-step-uses     $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - "uses": \'actions/checkout@v4\''
good closed-flow-then-dedent $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        foo: [a,\n          b]\n        os: [ubuntu-latest]\n    env:\n      os: linux\n    steps:\n      - run: echo ${{ matrix.foo }}'
bad block-scalar-in-matrix $'jobs:\n  j:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node: [22]\n        include:\n          - node: 22\n            setup: |\n              ["unclosed\n              it\'s\n    steps:\n      - run: echo ${{ matrix.node }}' 9 'block scalar'
good block-text-matrix-key $'jobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          echo "Matrix:" >> x\n          Matrix:\n          done'
good block-text-uses-key  $'jobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          cat <<EOF\n          Uses:\n          EOF'
good apostrophe-in-matrix $'jobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        note: [don\'t, it\'s]\n        name: it\'s fine\n    steps:\n      - run: echo ${{ matrix.note }}'
good static-jobs-step-alias $'jobs:\n  build:\n    if: github.event_name != \'pull_request\'\n    strategy:\n      matrix:\n        include:\n          - target: x86_64-apple-darwin\n            os: macos-latest\n    runs-on: ${{ matrix.os }}\n    steps: &build-steps\n      - run: echo ${{ matrix.target }}\n  build-pr:\n    if: github.event_name == \'pull_request\'\n    strategy:\n      matrix:\n        include:\n          - target: x86_64-unknown-linux-gnu\n            os: ubuntu-latest\n    runs-on: ${{ matrix.os }}\n    steps: *build-steps'

# --- the scan driver reads each workflow's committed bytes at HEAD -----------
repo() { # name: an empty repository at $tmp/<name>, in $r
  r=$tmp/$1
  mkdir -p "$r/.github/workflows" && git -C "$r" -c init.defaultBranch=main init -q
}
commit() {
  git -C "$r" add -A &&
    git -C "$r" -c user.name=selftest -c user.email=selftest@invalid -c commit.gpgsign=false \
      -c core.hooksPath=/dev/null commit -qm fixture
}
scanned() { # kind name [lines] [text]
  out=$(cd "$tmp/$2" && TMPDIR=$tmp bash "$scan" "$prog" 2>&1); rc=$?
  verdict "$1" "$2" "${3:-}" "${4:-}" || fail=1
}
pool=$'jobs:\n  j:\n    runs-on: build-pool'
hosted=$'jobs:\n  j:\n    runs-on: ubuntu-latest'
# A working-tree-encoding checkout is UTF-16, which hides every line from awk;
# GitHub runs the UTF-8 blob.
repo utf16 && printf '*.yml working-tree-encoding=UTF-16LE\n' > "$r/.gitattributes" &&
  printf '%s\n' "$pool" | iconv -f UTF-8 -t UTF-16LE > "$r/.github/workflows/x.yml" && commit || exit 1
if awk -f "$prog" "$r/.github/workflows/x.yml" > /dev/null; then scanned bad utf16 3
else echo "::error::selftest scan utf16: the UTF-16LE checkout does not hide the label from awk, so this fixture tests nothing"; fail=1; fi
repo dotfile && printf '%s\n' "$hosted" > "$r/.github/workflows/ci.yml" &&
  printf '%s\n' "$pool" > "$r/.github/workflows/.hidden.yml" && commit || exit 1
scanned bad dotfile 3
repo symlink && printf '%s\n' "$pool" > "$r/pool.yml" && ln -s ../../pool.yml "$r/.github/workflows/x.yml" && commit || exit 1
scanned bad symlink '' 'not a regular file'
repo uncommitted && printf '%s\n' "$hosted" > "$r/.github/workflows/x.yml" && commit &&
  printf '%s\n' "$pool" > "$r/.github/workflows/x.yml" || exit 1
scanned good uncommitted

if [ "$fail" -ne 0 ]; then echo "runner-drift-guard selftest FAILED"; exit 1; fi
echo "runner-drift-guard selftest OK ($(grep -c '^bad ' "$0") bad, $(grep -c '^good ' "$0") good, each also as CRLF; $(grep -cE '(^|[[:space:]])scanned (bad|good) ' "$0") scan)"
