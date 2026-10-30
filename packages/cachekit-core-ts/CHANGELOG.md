# Changelog

## [0.2.1](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-ts-v0.2.0...cachekit-core-ts-v0.2.1) (2026-10-27)


### Bug Fixes

* **cachekit-core-ts:** build napi without napi4 so a first load keeps no async context (LAB-10886) ([#256](https://github.com/cachekit-io/cachekit-ts/issues/256)) ([a5fbdda](https://github.com/cachekit-io/cachekit-ts/commit/a5fbddaaad69b6c1c314394ac7289fe327390f97))
* **deps:** update rust crate cachekit-core to 0.7.0 ([52823b0](https://github.com/cachekit-io/cachekit-ts/commit/52823b0bb76e157e3430af76a60de42835b14801))


### Performance Improvements

* **cachekit:** hash cache keys through the NAPI and wasm bindings (LAB-7141) ([#259](https://github.com/cachekit-io/cachekit-ts/issues/259)) ([1dc06f9](https://github.com/cachekit-io/cachekit-ts/commit/1dc06f9014687ebddd2f7905a36c9c9982f890f3))
* **deps:** bump cachekit-core to 0.7.2 (LAB-11012) ([#264](https://github.com/cachekit-io/cachekit-ts/issues/264)) ([be5a779](https://github.com/cachekit-io/cachekit-ts/commit/be5a779bd4f34374630c6efc3bde48ce9ffd516c))
* **deps:** update cachekit-core to 0.7.1 (LAB-10985) ([#257](https://github.com/cachekit-io/cachekit-ts/issues/257)) ([3bd2bb2](https://github.com/cachekit-io/cachekit-ts/commit/3bd2bb219a47e15496ea0a95b74c37de6e7ce7a3))

## [0.2.0](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-ts-v0.1.3...cachekit-core-ts-v0.2.0) (2026-10-21)


### Features

* **encryption:** previousMasterKeys keyring rotation surface (LAB-685) ([#103](https://github.com/cachekit-io/cachekit-ts/issues/103)) ([e7d1a8f](https://github.com/cachekit-io/cachekit-ts/commit/e7d1a8fffe7833078d363bed23b30199653327dd))
* **encryption:** surface hardware-acceleration detection (LAB-523) ([#132](https://github.com/cachekit-io/cachekit-ts/issues/132)) ([0ae83ba](https://github.com/cachekit-io/cachekit-ts/commit/0ae83ba54e804360b236e91385dfe47303538fba))


### Bug Fixes

* L1 TTL cap, loud size rejections, Node-free workers types (LAB-1388) ([#98](https://github.com/cachekit-io/cachekit-ts/issues/98)) ([13a3345](https://github.com/cachekit-io/cachekit-ts/commit/13a3345a8136f92e094995e6d68413e52c94a8b4))


### Performance Improvements

* **core-bindings:** return NAPI results as copied Uint8Arrays (LAB-7084) ([#171](https://github.com/cachekit-io/cachekit-ts/issues/171)) ([460a15f](https://github.com/cachekit-io/cachekit-ts/commit/460a15fe0978a6d6a3a8cf75bfad95841dd2ce57))

## [0.1.3](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-ts-v0.1.2...cachekit-core-ts-v0.1.3) (2026-08-03)


### Features

* **core-bindings:** pick up cachekit-core 0.4.0 — bin envelopes (LAB-901) ([#91](https://github.com/cachekit-io/cachekit-ts/issues/91)) ([763a3d8](https://github.com/cachekit-io/cachekit-ts/commit/763a3d8c899cf743c0a5777e18bc7411e64530fe))


### Bug Fixes

* wire the metrics option live — Prometheus module becomes the implementation (LAB-517) ([#75](https://github.com/cachekit-io/cachekit-ts/issues/75)) ([23721b9](https://github.com/cachekit-io/cachekit-ts/commit/23721b9b87dfb8410e47928d3f3025c60fdd8f0f))

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
