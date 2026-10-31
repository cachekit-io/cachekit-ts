# Contributing to cachekit-ts

Thanks for your interest. This project is in pre-1.0 development — see the [README](README.md#status) for what that means for stability. Bug reports, fixes, and well-scoped features are all welcome.

## Quick setup

```bash
pnpm install
pnpm build
pnpm test
```

Requirements: Node.js 22+, pnpm 11.11+, Rust stable (`pnpm build` compiles the native binding in `packages/cachekit-core-ts/` when that package's build task cache misses).

## Pre-commit hooks

One-time setup per clone:

```bash
prek install --install-hooks
```

Hooks run on every commit (ESLint + Prettier + actionlint + secret-scan + standard whitespace/yaml/json checks) and on every push (`pnpm type-check`). Falling back to Python `pre-commit` works identically against the same `.pre-commit-config.yaml`.

Of these hooks, CI re-runs only ESLint and the type-check (alongside its own build, test, audit and smoke-test jobs). Every other hook — Prettier, actionlint, secret-scan, cargo fmt/clippy and the file checks (whitespace, yaml/json/toml, large files, merge/case conflicts) — runs only locally, so install them.

## Documentation scope

User-facing docs (the READMEs and `docs/`) follow CacheKit's shared rule on what belongs in them:
[What belongs in these docs](https://docs.cachekit.io/contributing/#what-belongs-in-these-docs).
`prek install` (or `pre-commit install`) sets up hooks that reject internal references in README
files, `docs/` and commit messages. Another hook, `no-ticket-ids`, rejects internal ticket ids, with
or without the hyphen, in every tracked text file except the packages' `CHANGELOG.md` files and
`.github/workflows/pr-title-lint.yml`.

## How to send a change

1. **Open an issue first** for non-trivial work (anything beyond a typo or one-line fix). Saves both of us time if the direction is wrong.
2. **Branch off `main`** — `main` is protected; you can't push to it directly.
3. **Write a focused commit history** — small, reviewable commits. Don't squash exploratory work into one giant commit; we can squash on merge if it helps.
4. **Open a PR** against `main`. CI must be green before merge.

### Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) because [release-please](https://github.com/googleapis/release-please) reads them to cut releases automatically. Releasing types:

| Type                                               | When                          | Triggers release |
| -------------------------------------------------- | ----------------------------- | ---------------- |
| `feat:`                                            | New user-facing functionality | Yes (minor)      |
| `fix:`                                             | User-facing bug fix           | Yes (patch)      |
| `perf:`                                            | Performance improvement       | Yes (patch)      |
| `security:`                                        | Security fix                  | Yes (patch)      |
| `docs:` / `chore:` / `ci:` / `refactor:` / `test:` | Everything else               | No               |

Use the package directory as the scope when relevant: `feat(cachekit): ...` or `fix(cachekit-core-ts): ...`.

Breaking changes go in the commit body:

```
feat: rename createCache.minimal to createCache.fast

BREAKING CHANGE: createCache.minimal is now createCache.fast.
```

## Releasing

release-please opens one release PR per package: `@cachekit-io/cachekit`, `@cachekit-io/cachekit-core-ts` and `@cachekit-io/cachekit-core-wasm`. Merging a release PR tags that package, and the Release workflow publishes it to npm. The SDK depends on both cores as `workspace:*`, which `pnpm pack` writes as the exact version in each core's `package.json` at the SDK's release commit. So **the cores release before the SDK.** If the SDK released first, it would pin the previous cores, and its users would not get the core changes it was tested against.

The release-order gate (`.github/scripts/release-order-gate.mjs`) enforces this. It refuses the SDK release while either core has an open release PR, on the branch `release-please--branches--main--components--<core>`. An open core release PR is release-please's own verdict that the core has changes it would release, so the gate reads that verdict rather than re-parsing commits. It also refuses when it cannot tell, for example when the GitHub API fails or stalls. It runs in two places:

- **On the SDK's release PR**, as the `release-order` job under `CI Success`. If the job says a core has an open release PR, merge that PR, let the Release workflow publish the core, then re-run the SDK release PR's CI. If it says `Cannot check release order`, the job could not read GitHub; re-run it.
- **In the Release workflow, before the SDK is packed.** The release-please step in the same run opens or updates the core release PRs from the SDK's release commit, so this catches a core change that landed after the release PR's last CI run. Here the gate also checks the pins it is about to pack: each core's version in the checkout must equal the version `main`'s `.release-please-manifest.json` records as released. By then the SDK's tag exists, and re-running the job packs the same old pins. Once the cores have released, that re-run fails on this second check, so it cannot publish the old pins. Release the cores first. Then, if `main` has no SDK changes since the SDK's tag, run the Release workflow from `main` with `force_release: true`. If it does have SDK changes, release a new SDK patch instead.

A core change of a type release-please hides, such as `chore(deps)`, does not open a core release, so it does not hold the SDK either. To ship such a change before the next SDK release, recast it as releasable in its merged PR's body:

```
BEGIN_COMMIT_OVERRIDE
fix(deps): update the core crate
END_COMMIT_OVERRIDE
```

Editing a PR body triggers nothing, so release-please opens the core's release PR on the next Release run, after the next push to `main`. Wait for that PR to appear before you merge the SDK's release PR; the gate then holds the SDK until that core is released.

To release the SDK on purpose while a core release waits, snooze the core's release PR: close it and add the `autorelease: snooze` label. The SDK then pins the previous core, by your choice. The snooze holds only until a Release run generates a different body for that PR, and the body carries the run's UTC date, so in practice the first Release run on a later UTC day reopens it. So snooze it and merge the SDK's release PR on the same UTC day. If `build-cachekit` still refuses because the core PR reopened, snooze it again and re-run only the failed `build-cachekit` job, which does not run release-please again.

## Running tests

```bash
# All unit tests
pnpm test

# Single package
pnpm --filter @cachekit-io/cachekit test

# Integration tests (requires Docker for the Redis service container)
pnpm --filter @cachekit-io/cachekit test:integration

# Coverage
pnpm test:coverage
```

## Performance practices

These practices come from measured changes in this repo and in the sibling SDKs. Each says what to do, why, and the PR that measured it. Follow them in any change to a hot path: an L1 hit, an L2 hit, a miss, a set, their encrypted variants, and cold start. A perf PR shows its measurement; [Measuring performance](#measuring-performance) describes the harnesses and how to A/B a change.

1. **Do per-call work once.** Anything that depends only on configuration, the tenant, key material or the wrapped function is computed when the client, its tenant keys or the wrapper is built, not on every call: derived keys, fixed AAD parts, key prefixes, encoders and lookup tables.
   - [#254](https://github.com/cachekit-io/cachekit-ts/pull/254): a key memo per wrapped function cut the instructions of an L1 hit with one integer argument by 91.53%.
   - [#258](https://github.com/cachekit-io/cachekit-ts/pull/258): pre-encoding the AAD's fixed parts cut an encrypted NAPI round trip by 33.8%. The same PR checks a cheap bound before computing the exact value: UTF-8 never takes more than 3 bytes per UTF-16 unit, so key validation encodes a key only when three bytes per unit could exceed the limit.
   - A helper call on every hit is not free. Calling `ensureNotClosed()` on the hit path cost 108 instructions per hit, against about 1 for reading the flag inline ([#254](https://github.com/cachekit-io/cachekit-ts/pull/254)).
   - Limits: never memoise by value where equal values encode differently (in Python, `True`, `1` and `1.0` hash alike but encode differently in an AAD: [cachekit-io/cachekit-py#644](https://github.com/cachekit-io/cachekit-py/pull/644)). Never keep plaintext arguments alive in a memo on an encrypting cache. Bound every memo by entries, bytes and time.
   - V8 can hold a short string as a slice of a larger one, so a memo stores copied code units, never the strings it was passed. Twelve calls with 128-character ids sliced from 4 MiB strings kept about 50 MB alive on Node.js 22 and 24 ([#254](https://github.com/cachekit-io/cachekit-ts/pull/254)).
   - Runtime gotchas from the same PR: take timers from `node:timers`, because under Jest's jsdom environment the global `setTimeout` returns a number; and do not assume `WeakRef`, which older Workers lack.
2. **Use the native cores when the work outweighs the call boundary, and measure the boundary.** Hashing, AEAD and compression belong in the NAPI or wasm core, but each call into it has a fixed cost of its own.
   - [#259](https://github.com/cachekit-io/cachekit-ts/pull/259): BLAKE2b through the NAPI binding cut key generation by 78.2% at 45 B. Returning a hex string from Rust costs less than returning a `Uint8Array` and hex-encoding it in JS.
   - [#169](https://github.com/cachekit-io/cachekit-ts/pull/169): building the wasm core at opt-level 3 with `simd128` cut a 1 KB pack from 134,285 to 53,369 instructions (−60%).
   - [#264](https://github.com/cachekit-io/cachekit-ts/pull/264): the cachekit-core 0.7.2 bump cut a 40 B NAPI envelope round trip from 28,518 to 15,995 instructions (−43.91%).
   - [#171](https://github.com/cachekit-io/cachekit-ts/pull/171): copying NAPI results into V8-owned `Uint8Array`s beat external backing stores with finalizers. The 1 KB secure hit went from 41,458 to 28,807 instructions (−30.5%).
   - [#271](https://github.com/cachekit-io/cachekit-ts/pull/271): at 100 B, WebCrypto's fixed per-call cost is close to the wasm core's whole seal. Measure the small sizes, where the boundary dominates.
   - A named import of a missing export fails the whole entry, so read optional binding exports off the module namespace. A JS fallback hashes before it logs, because its input can be a view of a shared buffer that a logger making a key of its own would overwrite ([#259](https://github.com/cachekit-io/cachekit-ts/pull/259)).
3. **Allocate once and don't copy.** Size buffers exactly, write in place, and encode in one pass.
   - [#268](https://github.com/cachekit-io/cachekit-ts/pull/268): encoding an auto-mode value in one walk, instead of a deep copy and a second walk, cut a set by 11.97% at 64 B and 40.71% at 1 MB. A single-walk encoder must reproduce `encode()`'s depth bound and its getter read order and count, or the bytes and errors change.
   - [#254](https://github.com/cachekit-io/cachekit-ts/pull/254): building hex two digits at a time left about 800 B of intermediate strings per key, because V8 keeps every intermediate string inside the result.
   - A copy is not always the expensive option: see [#171](https://github.com/cachekit-io/cachekit-ts/pull/171) above.
4. **Count round trips per operation.** Pipeline dependent commands, skip checks an uncontended path cannot need, and keep follow-up work off the caller's path. The call-shape test pins these counts.
   - [#209](https://github.com/cachekit-io/cachekit-ts/pull/209): with the distributed lock on, skipping the double-check an uncontended miss cannot need and releasing the lock off the reply path took a cold miss from 5 requests to 4.
   - [cachekit-io/cachekit-py#660](https://github.com/cachekit-io/cachekit-py/pull/660): SADD and EXPIRE ride the SET's pipeline, 2N → N round trips for N tracked writes. A pipeline does not roll back, and neither would MULTI.
5. **Cold start is a hot path.** Load optional backends and integrations only when they are used.
   - [#186](https://github.com/cachekit-io/cachekit-ts/pull/186): loading ioredis with the Redis backend and prom-client off the op path took two one-off costs off every Node cold start. Both savings grow under CPU contention.
6. **Small values get their own path.** Most cached values are small, and fixed per-call costs dominate them. Benchmark at 40 B, 64 B, 1 KiB, 64 KiB and 1 MiB.
   - [cachekit-io/cachekit-core#128](https://github.com/cachekit-io/cachekit-core/pull/128): a literals-only LZ4 block below 64 B, −80.8% instructions on a 63 B store. `bench:ir`'s 40 B workloads sit under that cutover.
7. **Verify once.** Check untrusted bytes where they enter the process. After that, hold a value whose type says it was checked and that only the in-process cache can create, and stop re-running integrity checks and decompression on every hit. Verify lazily on the first hit, not at write time. The same rule applies to connections: don't ping before every operation, and return a connection to the pool only after a fully parsed success, dropping it on any error.
   - [cachekit-io/cachekit-py#662](https://github.com/cachekit-io/cachekit-py/pull/662): a backed L1 hit of a 1 MB value went from 2,254,711 to 219,522 instructions (−90.3%). Write-time admission cost about 32% more instructions on every miss and lost hits.
   - [#290](https://github.com/cachekit-io/cachekit-ts/pull/290): once the first encrypted L1 hit has walked a copy of the bytes that only the cache holds, later hits skip the depth pre-scan, and in auto mode the post-decode walk, −39.4% instructions at 10 KB. Copying at every L1 fill instead cost an encrypted 100 B set 5.8% more instructions. Trust a copy only the cache holds, never a buffer a backend still holds: the backend can write to it after you checked it.
8. **No per-operation cost that grows with the number of entries.** Expiry scans, policy bookkeeping and counts become a heap, an index or a running total.
   - [cachekit-io/cachekit-py#658](https://github.com/cachekit-io/cachekit-py/pull/658): a deadline heap instead of a scan, −97.2% instructions per put at 10,000 entries. A min-expiry watermark still scanned on 18–51% of puts in simulation: fix the structure, not the heuristic.
9. **Reserve shared state before you `await`.** JavaScript runs one thread, but any `await` lets another call run first, so reserve a value such as the nonce counter synchronously, before any `await` ([#271](https://github.com/cachekit-io/cachekit-ts/pull/271)).
10. **Measure it, or it didn't happen.** Use the harnesses in [Measuring performance](#measuring-performance), and publish no figure you did not measure. Three traps from this repo:
    - GC placement moves results on unchanged code. `l1-set-at-capacity-100k` read +2.64% at n = 2,000 and −10.3% at n = 20,000 on byte-identical code ([#259](https://github.com/cachekit-io/cachekit-ts/pull/259)). Before you claim a delta, check that the workload runs the code you changed.
    - The A/A floor does not capture code-layout differences between two builds, which can move AES-GCM by about 0.2% on their own ([#264](https://github.com/cachekit-io/cachekit-ts/pull/264)).
    - Instruction counts are not the whole story. In [#171](https://github.com/cachekit-io/cachekit-ts/pull/171), the 64 KB secure hit's instructions rose 31.6% while its wall time fell 53%. Time large payloads with paired, interleaved runs.

**Sibling paths.** A fix applied to one path tends to leave its siblings slow. When a perf PR changes a hot path, its description lists the sibling paths and says which it changed: NAPI and wasm, Node.js and Workers, plaintext and encrypted, L1-only and backed, `wrap()` and direct `get`/`set`, auto and interop mode, store and retrieve, the ESM and CommonJS entries, and the same path in the other SDKs.

## Measuring performance

Six harnesses measure the client.

**Call shape (runs in `pnpm test`).** `packages/cachekit/test/transport/call-shape.test.ts` runs the CachekitIO backend against a local TLS fake of the SaaS. It asserts the exact requests each op sends (a wrap miss is `GET` then `PUT`, and with `writeBehind` the caller waits for the `GET` only; a locked miss is `GET`, lock, `PUT`, unlock) and the connections 100 ops use. Each extra request is a round trip, and each extra connection is a TCP and TLS handshake. So if you change one of these numbers, change the expectation in the same PR and say why. The fake mints a throwaway certificate with the `openssl` CLI, and it needs Node 22.19+ or 24.5+ for `tls.setDefaultCACertificates`. Where either is missing, the tests fail with a message that names the requirement.

**Instructions per op (`pnpm --filter @cachekit-io/cachekit bench:ir`).** This counts the main-thread instructions of each hot path under callgrind: key generation through the NAPI hash (`keygen`, `keygen-1kb`) and the wasm hash (`keygen-wasm`, `keygen-wasm-1kb`), at 45 B and 1 KB of arguments, the serializer, the NAPI and wasm envelopes (1 KB, plus 40 B under the core's 64 B literals-only cutover and 64 KiB), both encrypted paths (1 KB, plus 64 KiB of incompressible bytes), and the L1 hit through `wrap()`, once with an object among the arguments and once with the single integer argument the README benchmark passes. Unlike wall-clock timing, instruction counts repeat on a busy machine. The suite pins V8's flags and counts only the measured ops. On Node 22 and 24, every path repeats within 0.01%. On Node 26, paths through the native cores repeat within about 0.3%, and `napi-encrypted` sometimes has a run about 1% low, which makes it read inconclusive. Gate on Node 22 or 24. It needs Linux and valgrind. It imports `dist/` and the wasm build, so run `pnpm build` and `pnpm --filter @cachekit-io/cachekit-core-wasm build:wasm` first; the second needs the `wasm32-unknown-unknown` target, `wasm-bindgen` and `wasm-opt`, and without it pass `--only` to skip the seven wasm workloads (`wasm-envelope`, `wasm-envelope-40b`, `wasm-envelope-64kb`, `wasm-encrypted`, `wasm-encrypted-64kb`, `keygen-wasm`, `keygen-wasm-1kb`). To A/B a change, run it on both builds on the same machine:

```bash
pnpm --filter @cachekit-io/cachekit bench:ir --save /tmp/base.json      # on the base build
pnpm --filter @cachekit-io/cachekit bench:ir --compare /tmp/base.json   # on your build
```

A workload more than 2% worse fails, and more than 1% worse warns. If the two runs come from a different node, V8 or valgrind, the compare refuses them. A run whose own repeats spread more than 0.4% (the A/A) reports inconclusive rather than passing. A compare also refuses (exit 2) two runs that measured different workloads, or two runs of the same build, and refuses to start when `--save` and `--compare` name the same file. A run that fails for any other reason (bad arguments, valgrind crash, missing build) exits 4, never 1. Add `--wall 9` to print indicative ns per op; it is not saved, and it is never a measured saving.

**Cold start (`pnpm --filter @cachekit-io/cachekit bench:cold-start`).** This times the import of the Node entry and the first three `wrap()` calls in fresh processes, interleaving the arms (default, metrics on, encryption on, and an A/A twin of default). Ops 2 and 3 are the warm baseline for op 1, and they show a cost that merely moved off op 1. `--entry cjs` requires `dist/cjs/index.js` instead of importing `dist/index.js`, and `--latency <ms>` makes every backend call wait that long on a timer, standing in for a network round trip. To A/B a change, copy the base build's `dist` inside `packages/cachekit` (so its dependencies resolve) and pass it as `--base <dir>`: every arm then runs on both builds in the same rotation, and the bench prints base minus head per arm as the median of the per-round differences. Claim only deltas larger than the A/A floor and the min-max band it prints.

**Per runtime (`pnpm --filter @cachekit-io/cachekit bench:runtime`).** This runs one probe script, `bench/runtime/probe.mjs`, unchanged under several runtimes against a local TLS fake of the SaaS, and compares them. Name each runtime binary with `--runtime name=path` (Node, Bun or Deno; without the flag it uses the current node, plus `bun` and `deno` if they are on PATH). Include Node 22: it is the `engines` floor. The probes import this checkout's `dist/`, so run `pnpm build` first; the fake mints a throwaway certificate with the `openssl` CLI for each run. The SDK refuses loopback addresses, so the probe gives the SDK the name `api.cachekit.test` and routes that one origin to `CACHEKIT_BENCH_HOST` (default `127.0.0.1`) by rewriting the URL in a thin wrapper around the global `fetch`. That works on every runtime with no `/etc/hosts` entry. Patching `node:dns` does not work here, because Bun's `fetch` does its own resolution. The fake offers h2 and http/1.1 and sends no Keep-Alive hint. It holds idle connections for 400 s, and it answers `HEAD` like the SaaS `exists` route in two variants: `head_cl=1` keeps the Content-Length of the JSON body, and `head_cl=0` sends none. Clients pool connections differently after the two, so every run covers both, and every output row records which variant it ran against, the runtime version, the build and the load average.

The output has two kinds of number. The **counts are the gates**. For each runtime and variant, the bench reports the ALPN protocol its `fetch` negotiates, the new connections and requests per op for `set`, warm `get` and `exists()`→`get` pairs, and whether the first `get` after each idle gap opens a new connection. The default gaps are 2, 5, 30, 70, 130, 250 and 400 s; the 2 and 5 s gaps bracket undici's 4 s idle timeout. Override them with `--gaps`, for example `--gaps 2,5` for a quick run (the full list takes about 15 minutes). Counts are deterministic, so each runtime runs twice, and the two runs must agree exactly; if they do not, the bench exits 1. The **wall-time and CPU cells are indicative only**. They are printed as ratios to `--ref` (the first runtime by default), from runs interleaved round by round. Each runtime also runs as its own A/A twin, and a ratio counts only when its distance from 1 is larger than the two runtimes' A/A spreads added together; otherwise it is marked `~`. The bench also reports the cold import time of the root entry (fresh process per sample, interleaved), and which entry and core (NAPI or wasm) each runtime loads. The `workers` entry is built for workerd, so it fails to load in other runtimes; that is expected, not a defect. `--json <file>` writes every row as JSONL.

These are loopback numbers, and loopback milliseconds do not carry over to a real network. On a 200 ms round trip, what a transport difference costs is its connection count: each new connection is a TLS handshake, which costs one to two round trips.

**README table (`pnpm --filter @cachekit-io/cachekit bench:readme`).** This prints the package README's Performance table. It runs the per-runtime probe's `cpu` mode in five fresh processes on the current node and prints the median of each figure as Markdown. Every row uses an in-memory backend, so the figures are the client's own work, with no network. It imports `dist/`, so run `pnpm build` first. The README quotes the run the `Bench` workflow makes on a GitHub-hosted runner, with that runner's CPU model; run the workflow from the Actions tab to refresh it.

**Live wall time (`bench/live/wall-time-probe.mjs`).** This times the real SDK against the cachekit.io dev endpoint, under node or bun, and writes one JSON row per request with its `cf-ray`, so each row can be matched to the service's own timing for that request. Two slots run the same arm in ABBA blocks, so their difference is the run's A/A floor, and each block starts on a new connection. It writes only to an allowlisted dev host, records every key in `--ledger` before the PUT that writes it, caps every TTL at 900 s, never retries, and stops (exit 3) on a 429, a 503, any other 4xx but 404, or a transport error. The key comes from `CACHEKIT_API_KEY` only. The header of the script lists every flag and the row fields.

## What `main` looks like

`main` is the integration branch and is **not guaranteed stable between releases**. Per-PR CI only builds the native crate on linux-x64 to keep PR turnaround fast; the full 5-platform matrix (linux x64/arm64, macOS x86/arm64, Windows) runs on `push: main`. Cross-platform regressions can land on `main` and stay there until the post-merge run catches them. A `cachekit-core-ts` release runs the same matrix again on its tag, and publishes the binaries that run builds; if any platform fails to build, nothing is published.

If you need stable, depend on a published version on npm.

## Dependency updates

**Renovate is the only bot that opens dependency PRs here** (config: `renovate.json`, extending `cachekit-io/renovate-config`). It also handles vulnerability remediation, but **only for dependencies that appear in a manifest** — `osvVulnerabilityAlerts` is documented as direct-dependencies-only, and Renovate removed transitive remediation outright in [renovatebot/renovate#27985](https://github.com/renovatebot/renovate/pull/27985).

**Vulnerable transitives get a weekly refresh, not a fix PR.** Renovate's lock file maintenance PR (Mondays, before 6am Sydney time) regenerates `pnpm-lock.yaml`, moving every transitive to the newest version its parents' declared ranges allow. That clears an advisory when the patched version is inside the range and has cleared the 24 h release-age quarantine below; a fix younger than that waits for the following week's refresh. It does not refresh the crates' `Cargo.lock` files: bump a vulnerable crate there by hand with `cargo update -p <crate>`. A fix outside the range needs you: find it with `pnpm audit`, then floor-pin it in `overrides` in `pnpm-workspace.yaml` — bounded to the major of the version you pin, because an unbounded floor re-resolves into new majors — and declare it in ci.yml's **Verify overrides match the declared set** step. Maintainers additionally watch the repo's Dependabot alerts (that page needs write access, so `pnpm audit` is the check to run from a fork).

Two traps in that loop. Pinning hands the dependency _back_ to Renovate — an `overrides` entry reads as a manifest dep, `depType` `pnpm-workspace.overrides` — but Renovate will also propose **widening** an upper bound across majors, as [#94](https://github.com/cachekit-io/cachekit-ts/pull/94) did to `brace-expansion@2` (`'>=2.1.3 <3'` → `'>=2.1.3 <6'`). That PR autoclosed; the behaviour that produced it did not change. An upper bound here is a deliberate decision, and it is now enforced in two layers rather than left to reviewer vigilance:

- `renovate.json` puts cross-major updates to `pnpm-workspace.overrides` entries behind **dependency-dashboard approval** — they still show up under _Pending Approval_, but no branch exists until a human clicks. This covers routine majors only. Any Renovate vulnerability-remediation update carries `force: {...vulnerabilityAlerts}`, which resets `dependencyDashboardApproval` to `false` no matter what repo config says (`force` is `globalOnly`), so this layer would _not_ have stopped [#94](https://github.com/cachekit-io/cachekit-ts/pull/94) — that PR was one.
- CI's **Verify overrides match the declared set** step declares every override with its shape: the upper-bound major of a bounded pin, or `floor` for an unbounded `>=floor`. It reads the overrides through `pnpm config get overrides`, which is exactly what install will apply, and fails the security job unless they match that set exactly. It catches widening, bound deletion, a new or removed override, and any rewrite into a range shape other than a plain `>=floor <N` or `>=floor`: an exact pin, a `||` union, or a bound like `<12.1` that admits part of the next major. Anything unrecognised reports as unparsed and fails closed. The step ends with a self-test: one-edit fixtures of the real overrides that the guard must fail. This is the layer that holds when a vulnerability-remediation PR or a hand edit rewrites one of the declared entries. A genuinely necessary cross-major security fix, as `uuid` needed when no in-major fix existed, stays possible. CI goes red, you read why, and in a commit that says so you change the bound and reshape its entry in that step (to `floor`, or to the new `<N`). If a self-test fixture targets the entry you changed, retarget it. Red is the discovery channel, not a wall.

Dependabot's _alert feed_ is a Renovate input: since 2026-09-28 the acting Renovate App has `vulnerability_alerts: read`, so the `Cannot access vulnerability alerts` warning is gone from the Dependency Dashboard. Renovate uses the feed to prioritise advisories on deps it can already see. It still opens no fix PR for a transitive, because that capability is gone upstream; the weekly lock refresh above is what reaches those.

**Release-age quarantine**: `pnpm-workspace.yaml` pins `minimumReleaseAge: 1440` (24 h). `pnpm install --frozen-lockfile` in CI rejects any lockfile entry younger than that — so a lockfile refresh that picks up a just-published version will fail CI until the release ages past the window. pnpm applies the same window when resolving, so a plain `pnpm install` on your machine normally picks mature versions automatically. Two cases still fail locally: a lockfile generated by a tool that ignores the window, and a range with **no** aged-in candidate at all — if every version satisfying a dependency (or an `overrides` floor) is younger than 24 h, resolution has nothing legal to pick and errors out rather than falling back. For a security backport that can't wait out the window — the usual cause of the second case — add a _version-scoped_ entry to `minimumReleaseAgeExclude` with a comment saying when it can be removed.

## Reporting bugs vs security issues

- **Bugs**: [open a GitHub issue](https://github.com/cachekit-io/cachekit-ts/issues/new)
- **Security vulnerabilities**: do NOT open a public issue. Use [GitHub's private vulnerability reporting](https://github.com/cachekit-io/cachekit-ts/security/advisories/new) or email security@cachekit.io. See [SECURITY.md](SECURITY.md) for the full policy.

## Code style

The pre-commit hooks enforce most of it (ESLint + Prettier for TS, `cargo fmt`/`cargo clippy` for Rust). Beyond that:

- Type hints on all public APIs
- Guard clauses over nested conditionals
- No `any` without a comment justifying it
- Prefer absolute imports
- Tests live alongside source: `foo.ts` ↔ `foo.test.ts`

## License

By contributing, you agree your work is licensed under the MIT License (see [LICENSE](LICENSE)).
