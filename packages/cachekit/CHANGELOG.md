# Changelog

## [0.1.5](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-v0.1.4...cachekit-v0.1.5) (2026-08-03)


### Features

* **cache:** cold-miss single-flight + opt-in cross-process locking (LAB-519) ([#77](https://github.com/cachekit-io/cachekit-ts/issues/77)) ([2fbfdee](https://github.com/cachekit-io/cachekit-ts/commit/2fbfdee2202e60bb8cea69e610c1a8a031e31bc5))
* **core-bindings:** pick up cachekit-core 0.4.0 — bin envelopes (LAB-901) ([#91](https://github.com/cachekit-io/cachekit-ts/issues/91)) ([763a3d8](https://github.com/cachekit-io/cachekit-ts/commit/763a3d8c899cf743c0a5777e18bc7411e64530fe))
* **workers:** LAB-750 Workers KV + Cache API backends (phase-2 edge storage) ([#81](https://github.com/cachekit-io/cachekit-ts/issues/81)) ([d0a0e3d](https://github.com/cachekit-io/cachekit-ts/commit/d0a0e3dce25136ff5088172ec026c822e228b934))
* **workers:** re-enable SWR on Workers via ctx.waitUntil (LAB-751) ([#80](https://github.com/cachekit-io/cachekit-ts/issues/80)) ([08fd853](https://github.com/cachekit-io/cachekit-ts/commit/08fd853714c99019aba2cb7fcfdf14e964130c46))


### Bug Fixes

* **swr:** preserve explicit writes during refresh (LAB-751) ([#84](https://github.com/cachekit-io/cachekit-ts/issues/84)) ([c4d4aed](https://github.com/cachekit-io/cachekit-ts/commit/c4d4aed8796df40af8942f487921cccbaa795d32))
* wire the metrics option live — Prometheus module becomes the implementation (LAB-517) ([#75](https://github.com/cachekit-io/cachekit-ts/issues/75)) ([23721b9](https://github.com/cachekit-io/cachekit-ts/commit/23721b9b87dfb8410e47928d3f3025c60fdd8f0f))

## [0.1.4](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-v0.1.3...cachekit-v0.1.4) (2026-07-24)


### Features

* Cloudflare Workers entrypoint on wasm32 cachekit-core (LAB-595) ([#78](https://github.com/cachekit-io/cachekit-ts/issues/78)) ([d70d225](https://github.com/cachekit-io/cachekit-ts/commit/d70d22597ed83bba83f5e82fae770289734067ce))
* Memcached + File backends (Node-only subpath exports) (LAB-430) ([#76](https://github.com/cachekit-io/cachekit-ts/issues/76)) ([e22928d](https://github.com/cachekit-io/cachekit-ts/commit/e22928d8a25beb1cc7bbefc98c222e62a08af762))

## [0.1.3](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-v0.1.2...cachekit-v0.1.3) (2026-07-23)


### Features

* interop mode (interop/v1) — cross-SDK keys and plain-MessagePack values [LAB-247] ([#71](https://github.com/cachekit-io/cachekit-ts/issues/71)) ([ad0fe0c](https://github.com/cachekit-io/cachekit-ts/commit/ad0fe0cdd089e20311f84b3f93547deff5f72394))
* **redis:** implement TTLBackend and LockableBackend (LAB-427) ([#74](https://github.com/cachekit-io/cachekit-ts/issues/74)) ([7178bb8](https://github.com/cachekit-io/cachekit-ts/commit/7178bb8d2e924753b786727f62cf00f062953756))


### Bug Fixes

* contested-lock 409 handling + pin bare-key lock contract ([#63](https://github.com/cachekit-io/cachekit-ts/issues/63) item 3) ([#70](https://github.com/cachekit-io/cachekit-ts/issues/70)) ([150035b](https://github.com/cachekit-io/cachekit-ts/commit/150035bf94f91d7493ebf17ace0653e5d06a6176))


### Security

* send lock_id via X-CacheKit-Lock-Id header, not query string ([#63](https://github.com/cachekit-io/cachekit-ts/issues/63)) ([#65](https://github.com/cachekit-io/cachekit-ts/issues/65)) ([40df857](https://github.com/cachekit-io/cachekit-ts/commit/40df85744f120c2a2cd32b1a7ff168d7712b220a))

## [0.1.2](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-v0.1.1...cachekit-v0.1.2) (2026-05-17)

### Release notes

- **0.1.1 was tagged but never published to npm** due to a CI auth failure (`ENEEDAUTH`) in the `Publish @cachekit-io/cachekit` job. Fixed in [#45](https://github.com/cachekit-io/cachekit-ts/pull/45). 0.1.2 is the first published release containing the post-0.1.0 changes.

### Documentation

- Correct Node.js requirement (18+ → 22+) to match `engines.node` ([#52](https://github.com/cachekit-io/cachekit-ts/pull/52))
- Add version-history note explaining the 0.1.0 → 0.1.2 jump on npm ([#52](https://github.com/cachekit-io/cachekit-ts/pull/52))

### Miscellaneous

- Patch transitive devDependency CVEs via `pnpm.overrides` (no runtime impact) ([#46](https://github.com/cachekit-io/cachekit-ts/pull/46))

## [0.1.1](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-v0.1.0...cachekit-v0.1.1) (2026-04-26)

### Features

- CachekitIO backend full parity — session, metrics, SSRF, errors, locking, TTL ([985cf09](https://github.com/cachekit-io/cachekit-ts/commit/985cf09bf1fd5cd12975bd0e504997b9eb9b8fd2))
- CachekitIO backend full parity (session, metrics, SSRF, locking, TTL) ([d408364](https://github.com/cachekit-io/cachekit-ts/commit/d408364a424a24f191632cc297519d1f951fb069))
- initial commit ([048585c](https://github.com/cachekit-io/cachekit-ts/commit/048585cb5e8934567a518b220337a4d10b48f83d))
- intent-based cache API (createCache.io, .minimal, .production, .secure) ([#42](https://github.com/cachekit-io/cachekit-ts/issues/42)) ([c551bfb](https://github.com/cachekit-io/cachekit-ts/commit/c551bfb75bf644a06a9c34eaa338c4980358a74a))
- wire ByteStorage into cache pipeline for protocol-compliant wire format ([#27](https://github.com/cachekit-io/cachekit-ts/issues/27)) ([d246294](https://github.com/cachekit-io/cachekit-ts/commit/d246294471967a49c4161a9f05f0232e84bf6c54))
