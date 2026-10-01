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

## Measuring performance

Three harnesses measure the client. None of them adds a dependency.

**Call shape (runs in `pnpm test`).** `packages/cachekit/test/transport/call-shape.test.ts` runs the CachekitIO backend against a local TLS fake of the SaaS. It asserts the exact requests each op sends (a wrap miss is `GET` then `PUT`; a locked miss is `GET`, lock, `GET`, `PUT`, unlock) and the connections 100 ops use. Each extra request is a round trip, and each extra connection is a TCP and TLS handshake. So if you change one of these numbers, change the expectation in the same PR and say why. The fake mints a throwaway certificate with the `openssl` CLI, and it needs Node 22.19+ or 24.5+ for `tls.setDefaultCACertificates`. Where either is missing, the tests fail with a message that names the requirement.

**Instructions per op (`pnpm --filter @cachekit-io/cachekit bench:ir`).** This counts the main-thread instructions of each hot path under callgrind: key generation, the serializer, the NAPI and wasm envelopes, both encrypted paths, and the L1 hit through `wrap()`. Unlike wall-clock timing, instruction counts repeat on a busy machine. The suite pins V8's flags and counts only the measured ops. On Node 22 and 24, every path repeats within 0.01%. On Node 26, paths through the native cores repeat within about 0.3%, and `napi-encrypted` sometimes has a run about 1% low, which makes it read inconclusive. Gate on Node 22 or 24. It needs Linux and valgrind, and it imports `dist/`, so run `pnpm build` first. To A/B a change, run it on both builds on the same machine:

```bash
pnpm --filter @cachekit-io/cachekit bench:ir --save /tmp/base.json      # on the base build
pnpm --filter @cachekit-io/cachekit bench:ir --compare /tmp/base.json   # on your build
```

A workload more than 2% worse fails, and more than 1% worse warns. If the two runs come from a different node, V8 or valgrind, the compare refuses them. A run whose own repeats spread more than 0.4% (the A/A) reports inconclusive rather than passing. A compare also refuses two runs that measured different workloads. Add `--wall 9` to print indicative ns per op; it is not saved, and it is never a measured saving.

**Cold start (`pnpm --filter @cachekit-io/cachekit bench:cold-start`).** This times the import of the Node entry and the first and second `wrap()` call in fresh processes, interleaving the arms (default, metrics on, encryption on, and an A/A twin of default). Claim only deltas larger than the A/A floor and the min-max band it prints.

## What `main` looks like

`main` is the integration branch and is **not guaranteed stable between releases**. Per-PR CI only builds the native crate on linux-x64 to keep PR turnaround fast; the full 5-platform matrix (linux x64/arm64, macOS x86/arm64, Windows) runs on `push: main` and on release tags. Cross-platform regressions can land on `main` and stay there until the post-merge run catches them — they're always caught before a release tag is cut, so published artifacts on npm are always validated against every platform.

If you need stable, depend on a published version on npm.

## Dependency updates

**Renovate is the only bot that opens dependency PRs here** (config: `renovate.json`, extending `cachekit-io/renovate-config`). It also handles vulnerability remediation, but **only for dependencies that appear in a manifest** — `osvVulnerabilityAlerts` is documented as direct-dependencies-only, and Renovate removed transitive remediation outright in [renovatebot/renovate#27985](https://github.com/renovatebot/renovate/pull/27985).

**Vulnerable transitives get a weekly refresh, not a fix PR.** Renovate's lock file maintenance PR (Mondays, before 6am Sydney time) regenerates `pnpm-lock.yaml`, moving every transitive to the newest version its parents' declared ranges allow. That clears an advisory when the patched version is inside the range and has cleared the 24 h release-age quarantine below; a fix younger than that waits for the following week's refresh. It does not refresh the crates' `Cargo.lock` files: bump a vulnerable crate there by hand with `cargo update -p <crate>`. A fix outside the range needs you: find it with `pnpm audit`, then floor-pin it in `overrides` in `pnpm-workspace.yaml` — bounded to the major of the version you pin, because an unbounded floor re-resolves into new majors. Maintainers additionally watch the repo's Dependabot alerts (that page needs write access, so `pnpm audit` is the check to run from a fork).

Two traps in that loop. Pinning hands the dependency _back_ to Renovate — an `overrides` entry reads as a manifest dep, `depType` `pnpm-workspace.overrides` — but Renovate will also propose **widening** an upper bound across majors, as [#94](https://github.com/cachekit-io/cachekit-ts/pull/94) did to `brace-expansion@2` (`'>=2.1.3 <3'` → `'>=2.1.3 <6'`). That PR autoclosed; the behaviour that produced it did not change. An upper bound here is a deliberate decision, and it is now enforced in two layers rather than left to reviewer vigilance:

- `renovate.json` puts cross-major updates to `pnpm-workspace.overrides` entries behind **dependency-dashboard approval** — they still show up under _Pending Approval_, but no branch exists until a human clicks. This covers routine majors only. Any Renovate vulnerability-remediation update carries `force: {...vulnerabilityAlerts}`, which resets `dependencyDashboardApproval` to `false` no matter what repo config says (`force` is `globalOnly`), so this layer would _not_ have stopped [#94](https://github.com/cachekit-io/cachekit-ts/pull/94) — that PR was one.
- CI's **Verify bounded floor-pins stay in-major** step declares the bounded pins and their upper-bound majors, reads the overrides through `pnpm config get overrides` — exactly what install will apply — and fails the security job unless they match that set exactly. It catches widening, bound deletion, and any rewrite into a range shape other than a plain `>=floor <N` (a `||` union, or a bound like `<12.1` that admits part of the next major) — anything unrecognised drops out of the comparison and fails closed. This is the layer that holds when a vulnerability-remediation PR or a hand edit rewrites one of the declared entries. A genuinely necessary cross-major security fix — as `uuid` needed when no in-major fix existed — stays possible: CI goes red, you read why, and you remove the bound and its entry in that step in a commit that says so. Red is the discovery channel, not a wall.

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
