# Contributing to cachekit-ts

Thanks for your interest. This project is in pre-1.0 development — see the [README](README.md#status) for what that means for stability. Bug reports, fixes, and well-scoped features are all welcome.

## Quick setup

```bash
pnpm install
pnpm build
pnpm test
```

Requirements: Node.js 22+, pnpm 8+, Rust stable (only needed if you touch `packages/cachekit-core-ts/`).

## Pre-commit hooks

One-time setup per clone:

```bash
prek install --install-hooks
```

Hooks run on every commit (ESLint + Prettier + actionlint + secret-scan + standard whitespace/yaml/json checks) and on every push (`pnpm type-check`). Falling back to Python `pre-commit` works identically against the same `.pre-commit-config.yaml`.

If you don't install the hooks, CI will catch the same things — just slower and noisier.

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

## CI on external (fork) PRs

GitHub disables self-hosted runners for fork PRs by security policy. Our CI workflows detect this and fall back to `ubuntu-latest` automatically — no action needed on your side. The full job matrix runs identically; only the runner host differs.

## What `main` looks like

`main` is the integration branch and is **not guaranteed stable between releases**. Per-PR CI only builds the native crate on linux-x64 to keep PR turnaround fast; the full 5-platform matrix (linux x64/arm64, macOS x86/arm64, Windows) runs on `push: main` and on release tags. Cross-platform regressions can land on `main` and stay there until the post-merge run catches them — they're always caught before a release tag is cut, so published artifacts on npm are always validated against every platform.

If you need stable, depend on a published version on npm.

## Dependency updates

**Renovate is the only bot that opens dependency PRs here** (config: `renovate.json`, extending `cachekit-io/renovate-config`). It also handles vulnerability remediation, but **only for dependencies that appear in a manifest** — `osvVulnerabilityAlerts` is documented as direct-dependencies-only, and Renovate removed transitive remediation outright in [renovatebot/renovate#27985](https://github.com/renovatebot/renovate/pull/27985).

**Vulnerable transitives have no bot.** Find them with `pnpm audit`, then floor-pin them in `overrides` in `pnpm-workspace.yaml` — bounded to the major of the version you pin, because an unbounded floor re-resolves into new majors. Maintainers additionally watch the repo's Dependabot alerts (that page needs write access, so `pnpm audit` is the check to run from a fork).

Two traps in that loop. Pinning hands the dependency _back_ to Renovate — an `overrides` entry reads as a manifest dep — but Renovate will also propose **widening** an upper bound across majors, as open PR #94 does to `brace-expansion@2`. An upper bound here is a deliberate decision; re-derive it before approving a bot PR that moves one. And Dependabot's _alert feed_, though still enabled, is not a Renovate input: as of 2026-07-30 the acting Renovate App lacks `vulnerability_alerts: read`, which is what the `Cannot access vulnerability alerts` warning on every Dependency Dashboard reports. Granting that scope would silence the warning and let Renovate prioritise advisories on deps it can already see — it would not produce transitive fix PRs, because that capability is gone upstream regardless.

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
