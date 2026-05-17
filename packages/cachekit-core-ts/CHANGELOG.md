# Changelog

## [0.1.2](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-ts-v0.1.1...cachekit-core-ts-v0.1.2) (2026-05-17)

### Release notes

- **0.1.1 was tagged but never published to npm** due to a CI bug in `build-native.yml`: `@napi-rs/cli` v3 renamed `--artifacts-dir` to `--output-dir`, causing the `Move artifacts to platform packages` step to fail. Fixed in [#51](https://github.com/cachekit-io/cachekit-ts/pull/51). 0.1.2 is the first published release containing the post-0.1.0 changes — including the initial publication of all 5 native platform packages (`@cachekit-io/cachekit-core-ts-{linux-x64-gnu,linux-arm64-gnu,darwin-x64,darwin-arm64,win32-x64-msvc}`).

### Documentation

- Add package README describing platform packages, N-API surface, and the 0.1.0 → 0.1.2 version note ([#52](https://github.com/cachekit-io/cachekit-ts/pull/52))

## [0.1.1](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-ts-v0.1.0...cachekit-core-ts-v0.1.1) (2026-04-26)

### Features

- CachekitIO backend full parity (session, metrics, SSRF, locking, TTL) ([d408364](https://github.com/cachekit-io/cachekit-ts/commit/d408364a424a24f191632cc297519d1f951fb069))
- initial commit ([048585c](https://github.com/cachekit-io/cachekit-ts/commit/048585cb5e8934567a518b220337a4d10b48f83d))
- wire ByteStorage into cache pipeline for protocol-compliant wire format ([#27](https://github.com/cachekit-io/cachekit-ts/issues/27)) ([d246294](https://github.com/cachekit-io/cachekit-ts/commit/d246294471967a49c4161a9f05f0232e84bf6c54))
