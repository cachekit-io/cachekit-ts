# Changelog

## [0.2.1](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-wasm-v0.2.0...cachekit-core-wasm-v0.2.1) (2026-10-28)


### Bug Fixes

* **deps:** update rust crate cachekit-core to 0.7.0 ([52823b0](https://github.com/cachekit-io/cachekit-ts/commit/52823b0bb76e157e3430af76a60de42835b14801))


### Performance Improvements

* **cachekit:** hash cache keys through the NAPI and wasm bindings (LAB-7141) ([#259](https://github.com/cachekit-io/cachekit-ts/issues/259)) ([1dc06f9](https://github.com/cachekit-io/cachekit-ts/commit/1dc06f9014687ebddd2f7905a36c9c9982f890f3))
* **deps:** bump cachekit-core to 0.7.2 (LAB-11012) ([#264](https://github.com/cachekit-io/cachekit-ts/issues/264)) ([be5a779](https://github.com/cachekit-io/cachekit-ts/commit/be5a779bd4f34374630c6efc3bde48ce9ffd516c))

## [0.2.0](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-wasm-v0.1.2...cachekit-core-wasm-v0.2.0) (2026-10-16)


### Features

* **encryption:** previousMasterKeys keyring rotation surface (LAB-685) ([#103](https://github.com/cachekit-io/cachekit-ts/issues/103)) ([e7d1a8f](https://github.com/cachekit-io/cachekit-ts/commit/e7d1a8fffe7833078d363bed23b30199653327dd))
* **encryption:** surface hardware-acceleration detection (LAB-523) ([#132](https://github.com/cachekit-io/cachekit-ts/issues/132)) ([0ae83ba](https://github.com/cachekit-io/cachekit-ts/commit/0ae83ba54e804360b236e91385dfe47303538fba))


### Performance Improvements

* **core-wasm:** build at opt-level 3 with simd128 (LAB-7083) ([#169](https://github.com/cachekit-io/cachekit-ts/issues/169)) ([47d1ea3](https://github.com/cachekit-io/cachekit-ts/commit/47d1ea3a707bd98099576679f2aa5890060cdab6))

## [0.1.2](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-wasm-v0.1.1...cachekit-core-wasm-v0.1.2) (2026-08-03)


### Features

* **core-bindings:** pick up cachekit-core 0.4.0 — bin envelopes (LAB-901) ([#91](https://github.com/cachekit-io/cachekit-ts/issues/91)) ([763a3d8](https://github.com/cachekit-io/cachekit-ts/commit/763a3d8c899cf743c0a5777e18bc7411e64530fe))

## [0.1.1](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-core-wasm-v0.1.0...cachekit-core-wasm-v0.1.1) (2026-07-24)


### Features

* Cloudflare Workers entrypoint on wasm32 cachekit-core (LAB-595) ([#78](https://github.com/cachekit-io/cachekit-ts/issues/78)) ([d70d225](https://github.com/cachekit-io/cachekit-ts/commit/d70d22597ed83bba83f5e82fae770289734067ce))
