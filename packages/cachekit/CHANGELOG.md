# Changelog

## [0.2.0](https://github.com/cachekit-io/cachekit-ts/compare/cachekit-v0.1.5...cachekit-v0.2.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **intents:** `createCache.minimal()`, `.production()`, `.secure()` and `.io()` now throw `ConfigurationError` at construction for any option they do not apply. `encryption`, `masterKey`, `previousMasterKeys` or `tenantId` on `minimal` or `production` throws: use `createCache.secure()`, `createCache.io()` with `encryption`, or `createCache()` with `encryption`. `encryption` on `secure` throws: pass `masterKey`, `previousMasterKeys` and `tenantId` at the top level. `masterKey`, `previousMasterKeys` or `tenantId` at the top level of `io` throws: nest them under `encryption`. `backend`, `url` and `keyPrefix` on `io`, `metrics` and `reliability` on `minimal`, `stampede` on any preset, `keyPrefix` beside a `backend` instance, and misspelt options such as `defaultTtl` also throw. An option set to `undefined` is still accepted. On every encrypted cache, and in `new EncryptionManager(…)`, a `tenantId` that is set but is not a string, such as `null`, throws `ConfigurationError`.
* **encryption:** bind the backend keyPrefix in the AES-GCM AAD (LAB-6396) ([#208](https://github.com/cachekit-io/cachekit-ts/issues/208))
* **l1:** `L1Cache` and `createCache` (via its `l1` option) now reject an `l1.maxMemory` of `Infinity`, `NaN`, `0` or a negative number, throwing `ConfigurationError`. A caller who passed `Infinity` for "no memory bound" should pass `Number.MAX_SAFE_INTEGER`; `maxEntries` remains the hard bound on L1's size. Every `l1` field set to `undefined` or `null` now takes its default instead of replacing it.
* **serialization:** `MessagePackSerializer` (and `createCache` via its `serializer` option) now rejects `maxEncodedSize`, `maxDecodedSize` or `maxCollectionSize` set to `undefined`, `NaN`, `Infinity`, `0`, a negative number or a non-integer, throwing `ConfigurationError`. A caller who passed `Infinity` for "no limit" should pass `Number.MAX_SAFE_INTEGER`.
* **serialization:** serializer.maxDepth must now be an integer from 32 to 1024. Any other value, including NaN, Infinity or an explicit undefined, throws ConfigurationError when the cache is created. Previously, values below 32 were honoured, and NaN or undefined silently disabled the depth check.
* **interop:** an interop namespace or operation containing `..` now throws `ConfigurationError` at wrap time, on every backend; the exported `generateInteropKey` throws it at call time. Rename the segment; its keys become a full cache miss.
* **invalidation:** `L1Config.invalidationEnabled` is removed from the exported `L1Config` interface and from `DEFAULT_L1_CONFIG`, and the intent presets no longer set it. Nothing read the field. TypeScript consumers that set `invalidationEnabled` will get a compile error and should delete the property. Runtime behavior does not change. Separately, `invalidate('params')` without a key now stops before any L1 mutation, `backend.delete`, or invalidation publish, logs once and resolves; it previously resolved silently and still published a `params` event with no hash.
* **interop:** `ns` and `nsapi` are reserved interop namespaces. `cache.wrap`, `generateInteropKey` and `validateInteropSegment` throw `ConfigurationError` for them, and for non-string namespace or operation segments. Deployments that used `ns` or `nsapi` as an interop namespace on non-CachekitIO backends must rename the namespace. The rename makes every existing entry in that namespace a cache miss.
* **encryption:** a `secure` cache created without a `tenantId` now binds tenant `"default"` into the AES-GCM AAD instead of `""`. That is the value HKDF already derived its key from and the value the protocol requires, so a tenant-less cachekit-ts `secure` cache now shares ciphertext with cachekit-py and cachekit-rs on tenant `"default"`. Caches with an explicit `tenantId` are unaffected. Entries written by a tenant-less `secure` cache on `@cachekit-io/cachekit` 0.1.5 or earlier no longer authenticate, so every read of one fails decryption. To migrate, delete those entries (or switch to a fresh namespace or key prefix) once no pre-upgrade instance is still writing; during a rolling upgrade, old and new instances cannot read each other's entries. Do not wait out the TTL instead. Under the `secure` preset's default settings, each undecryptable read returns a miss; it is not retried and does not count as a circuit-breaker failure.
* **cache:** secure.wrap() fails closed when encryption is not configured (LAB-513) ([#123](https://github.com/cachekit-io/cachekit-ts/issues/123))

### Features

* **cachekit:** User-Agent, per-runtime probes and a live dev harness (LAB-7059) ([#195](https://github.com/cachekit-io/cachekit-ts/issues/195)) ([a35bdd7](https://github.com/cachekit-io/cachekit-ts/commit/a35bdd76734cbd6d835e4bedf27a9a952e8b84fd))
* **encryption:** previousMasterKeys keyring rotation surface (LAB-685) ([#103](https://github.com/cachekit-io/cachekit-ts/issues/103)) ([e7d1a8f](https://github.com/cachekit-io/cachekit-ts/commit/e7d1a8fffe7833078d363bed23b30199653327dd))
* **encryption:** surface hardware-acceleration detection (LAB-523) ([#132](https://github.com/cachekit-io/cachekit-ts/issues/132)) ([0ae83ba](https://github.com/cachekit-io/cachekit-ts/commit/0ae83ba54e804360b236e91385dfe47303538fba))
* **retry:** add `retry.deadline`, one budget in ms shared by all attempts of an operation; the production, secure and io presets set it to 5000 (LAB-7080) ([#200](https://github.com/cachekit-io/cachekit-ts/issues/200)) ([f978bbe](https://github.com/cachekit-io/cachekit-ts/commit/f978bbe2f2c9b42fd3e6c7de3e6da5ac61066a60))


### Bug Fixes

* **cache:** bound envelope unpack by maxDecodedSize (LAB-2732) ([#141](https://github.com/cachekit-io/cachekit-ts/issues/141)) ([898d37d](https://github.com/cachekit-io/cachekit-ts/commit/898d37d24ffec751c158f6ff3a6d4921e67b08dc))
* **cache:** decode a decrypted plaintext as plain MessagePack, never a sniffed envelope (LAB-8182) ([#213](https://github.com/cachekit-io/cachekit-ts/issues/213)) ([7be7f40](https://github.com/cachekit-io/cachekit-ts/commit/7be7f40649eebdd09c8a58648f9ac9fc038709e9))
* **cache:** decode after run('get') so decode failures are not retried or counted by the breaker (LAB-7079) ([#175](https://github.com/cachekit-io/cachekit-ts/issues/175)) ([3b646f6](https://github.com/cachekit-io/cachekit-ts/commit/3b646f6fff739702049086b243c1efeba88bcecd))
* **cachekitio:** default to a 5 s per-attempt timeout inside one shared retry deadline (LAB-7080) ([#200](https://github.com/cachekit-io/cachekit-ts/issues/200)) ([f978bbe](https://github.com/cachekit-io/cachekit-ts/commit/f978bbe2f2c9b42fd3e6c7de3e6da5ac61066a60))
* **cachekitio:** DELETE never reports existence, so a 404 throws (LAB-5580) ([#178](https://github.com/cachekit-io/cachekit-ts/issues/178)) ([6499bd8](https://github.com/cachekit-io/cachekit-ts/commit/6499bd8c3a0b53344a1a1dbc7eab7f7b37a21930))
* **cachekitio:** honour X-CacheKit-Freshness and Fresh-For before backfilling L1 (LAB-7883) ([#206](https://github.com/cachekit-io/cachekit-ts/issues/206)) ([985df71](https://github.com/cachekit-io/cachekit-ts/commit/985df710068e667d171778ada451389fa372cd77))
* **cachekitio:** never follow redirects; tighten API URL validation and send the URL as parsed (LAB-8208) ([#216](https://github.com/cachekit-io/cachekit-ts/issues/216)) ([6af4b80](https://github.com/cachekit-io/cachekit-ts/commit/6af4b80bf21623467ee730fc183f96c8c3cf736e))
* **cachekitio:** reject reserved cache-key segments in request path (CWE-22, LAB-2877) ([#118](https://github.com/cachekit-io/cachekit-ts/issues/118)) ([c93083b](https://github.com/cachekit-io/cachekit-ts/commit/c93083b27a53fd1e7bdd1bd96b8c20e10f834a79))
* **cachekitio:** send X-CacheKit-TTL and reject invalid TTLs per protocol spec (LAB-239) ([#110](https://github.com/cachekit-io/cachekit-ts/issues/110)) ([0862629](https://github.com/cachekit-io/cachekit-ts/commit/0862629d88cafd127bcf132b31b15fac594d5a8d))
* **cachekitio:** take only a non-empty string lock_id as a lease (LAB-8206) ([#215](https://github.com/cachekit-io/cachekit-ts/issues/215)) ([f6045cc](https://github.com/cachekit-io/cachekit-ts/commit/f6045cc081c316523fef788b4adc5d901fa5dee7))
* **cache:** log a pack or encrypt failure that degradation absorbs (LAB-7539) ([#188](https://github.com/cachekit-io/cachekit-ts/issues/188)) ([cc17ba2](https://github.com/cachekit-io/cachekit-ts/commit/cc17ba214778a5ad9db50e4de2dc7b0a8b531feb))
* **cache:** pack and encrypt set() values before the reliability executor (LAB-7203) ([#185](https://github.com/cachekit-io/cachekit-ts/issues/185)) ([f8357e4](https://github.com/cachekit-io/cachekit-ts/commit/f8357e4ec9f3ce16d89ebe443db240492b1e6260))
* **cache:** read legacy array-encoded envelopes on compression-off caches (LAB-5642) ([#163](https://github.com/cachekit-io/cachekit-ts/issues/163)) ([d85ec11](https://github.com/cachekit-io/cachekit-ts/commit/d85ec11e3918ad32f35500be4462d448b619c3c8))
* **cache:** secure.wrap() fails closed when encryption is not configured (LAB-513) ([#123](https://github.com/cachekit-io/cachekit-ts/issues/123)) ([87dee26](https://github.com/cachekit-io/cachekit-ts/commit/87dee26ffd8d3e433a4f681c93cfd2dc85d95144))
* **cache:** serialize set() values before the reliability executor (LAB-5139) ([#136](https://github.com/cachekit-io/cachekit-ts/issues/136)) ([4d44605](https://github.com/cachekit-io/cachekit-ts/commit/4d446059000933e4f6e27693af31ae8d2b90ab32))
* **cache:** warn on every set() encode rejection, not just size (LAB-4845) ([#140](https://github.com/cachekit-io/cachekit-ts/issues/140)) ([b11f48e](https://github.com/cachekit-io/cachekit-ts/commit/b11f48ed2d3530ef5ab54eb717ebe13a4ae2bcb8))
* **cache:** write L1 in wrap() even when the L2 write fails (LAB-7157) ([#173](https://github.com/cachekit-io/cachekit-ts/issues/173)) ([969a700](https://github.com/cachekit-io/cachekit-ts/commit/969a700377d8b115e1ee54bcd2326a46ac945445))
* **deps:** require ioredis ^5.11.1 so the url check matches the parser (LAB-7566) ([#191](https://github.com/cachekit-io/cachekit-ts/issues/191)) ([74f01fc](https://github.com/cachekit-io/cachekit-ts/commit/74f01fceb4e9e55ab85b57e8b9279d2ea1547197))
* **encryption:** bind the backend keyPrefix in the AES-GCM AAD (LAB-6396) ([#208](https://github.com/cachekit-io/cachekit-ts/issues/208)) ([490a5a3](https://github.com/cachekit-io/cachekit-ts/commit/490a5a34e1ecb847c4dbb6d94c260aeb30ee84ea))
* **encryption:** resolve tenant_id once for HKDF and AAD (LAB-4668) ([#133](https://github.com/cachekit-io/cachekit-ts/issues/133)) ([8bb5269](https://github.com/cachekit-io/cachekit-ts/commit/8bb52697ae9c2bdce3b407dd4cc8d02bcad9fef6))
* **encryption:** throw ConfigurationError for secure-cache keys over the 64 KiB AAD limit (LAB-5142) ([#138](https://github.com/cachekit-io/cachekit-ts/issues/138)) ([b777ada](https://github.com/cachekit-io/cachekit-ts/commit/b777adafedb772505ed1954cb22df2663c731fdc))
* **envelope:** name size-cap, zero-length and ratio rejections; run wire-format reject vectors (LAB-7483) ([#198](https://github.com/cachekit-io/cachekit-ts/issues/198)) ([2e44a33](https://github.com/cachekit-io/cachekit-ts/commit/2e44a3382ce780dbb76b63b7924e69c97677aafe))
* **envelope:** refuse a slot over-claim with the envelope pre-scan's own error (LAB-8577) ([#232](https://github.com/cachekit-io/cachekit-ts/issues/232)) ([3f81a17](https://github.com/cachekit-io/cachekit-ts/commit/3f81a17d5ef119bc45b5cbcfdf6871f9849896cc))
* **file:** expire a File-backend entry at its expiry second (LAB-8073) ([#212](https://github.com/cachekit-io/cachekit-ts/issues/212)) ([14aa68c](https://github.com/cachekit-io/cachekit-ts/commit/14aa68c5dae4d489bd29e40e909db0407fc01e46))
* **intents:** minimal honours explicit L1 flags; reject an empty tenantId at construction (LAB-8225) ([#226](https://github.com/cachekit-io/cachekit-ts/issues/226)) ([d087944](https://github.com/cachekit-io/cachekit-ts/commit/d08794468c49d9e753118d55e5e57e73907b27e3))
* **intents:** reject options a createCache preset does not apply (LAB-8218) ([#214](https://github.com/cachekit-io/cachekit-ts/issues/214)) ([fce2e9b](https://github.com/cachekit-io/cachekit-ts/commit/fce2e9b983ea32efd1b9cd3c076c61b9405746d6))
* **interop:** cap a Set's size before encoding its elements (LAB-7831) ([#201](https://github.com/cachekit-io/cachekit-ts/issues/201)) ([4ebac78](https://github.com/cachekit-io/cachekit-ts/commit/4ebac78817df09979688f0ffacf79f0695868822))
* **interop:** fire map/object collection cap before key materialisation (LAB-413) ([#113](https://github.com/cachekit-io/cachekit-ts/issues/113)) ([403b1b3](https://github.com/cachekit-io/cachekit-ts/commit/403b1b3a0d8c06e06982696fcd94619b26e240fe))
* **interop:** read __proto__ keys and U+FEFF strings; re-vendor interop-mode 1.3.0 and decode-bounds 1.2.0 (LAB-8308) ([#224](https://github.com/cachekit-io/cachekit-ts/issues/224)) ([a8e8e0b](https://github.com/cachekit-io/cachekit-ts/commit/a8e8e0b57573d759253a1f89ffa48ca12079719f))
* **interop:** reject double-dot interop segments (LAB-5906) ([#164](https://github.com/cachekit-io/cachekit-ts/issues/164)) ([4ae5c90](https://github.com/cachekit-io/cachekit-ts/commit/4ae5c9043b82e26f6a8a37ab92b949617543b910))
* **interop:** reject reserved namespaces ns and nsapi (LAB-5876) ([#143](https://github.com/cachekit-io/cachekit-ts/issues/143)) ([40835c8](https://github.com/cachekit-io/cachekit-ts/commit/40835c8e45b0ef9cd3ecd9ef353aef9362daf47c))
* **interop:** reject Symbol-keyed object properties (LAB-8740) ([#233](https://github.com/cachekit-io/cachekit-ts/issues/233)) ([d0eaf3e](https://github.com/cachekit-io/cachekit-ts/commit/d0eaf3e775ad9b668a7a5dd20c2f56774d458891))
* **invalidation:** deserializeEvent fails closed with SerializationError on every malformed payload (LAB-3477) ([#126](https://github.com/cachekit-io/cachekit-ts/issues/126)) ([059ccc6](https://github.com/cachekit-io/cachekit-ts/commit/059ccc609a1bba816a20435b17f385ed3535b144))
* **invalidation:** invalidate() reports params no-ops and L2 delete failures; remove dead l1.invalidationEnabled (LAB-4576) ([#149](https://github.com/cachekit-io/cachekit-ts/issues/149)) ([a788aa2](https://github.com/cachekit-io/cachekit-ts/commit/a788aa21543fb5b8a187154f6a3bf5ca0ce5f4b8))
* **invalidation:** report a non-string key or namespace at the caller (LAB-6400) ([#160](https://github.com/cachekit-io/cachekit-ts/issues/160)) ([cca8365](https://github.com/cachekit-io/cachekit-ts/commit/cca83651bccde3a299feddf45c7d71cb23a8705d))
* L1 TTL cap, loud size rejections, Node-free workers types (LAB-1388) ([#98](https://github.com/cachekit-io/cachekit-ts/issues/98)) ([13a3345](https://github.com/cachekit-io/cachekit-ts/commit/13a3345a8136f92e094995e6d68413e52c94a8b4))
* **l1:** cap one entry's charge at an eighth of maxMemory (LAB-7810) ([#196](https://github.com/cachekit-io/cachekit-ts/issues/196)) ([2c20485](https://github.com/cachekit-io/cachekit-ts/commit/2c20485238c4be61033ca6c05cd04075b6ec9e19))
* **l1:** charge an overflowing size hint or count as no hint (LAB-7584) ([#204](https://github.com/cachekit-io/cachekit-ts/issues/204)) ([692e00e](https://github.com/cachekit-io/cachekit-ts/commit/692e00e13568ccc89e1bb98ac6b38a55052d527d))
* **l1:** charge maxMemory per container, not just per serialized byte (LAB-7688) ([#193](https://github.com/cachekit-io/cachekit-ts/issues/193)) ([17c2a85](https://github.com/cachekit-io/cachekit-ts/commit/17c2a854b96b3de1fe2916fbf9888f1a8a1bc8f9))
* **l1:** charge maxMemory per element and entry, not just per object (LAB-7723) ([#199](https://github.com/cachekit-io/cachekit-ts/issues/199)) ([19b6f80](https://github.com/cachekit-io/cachekit-ts/commit/19b6f80db852039b67c44a6d242d3f2b2ecf63c1))
* **l1:** escape sourceInstance in-library before it reaches the log sink (LAB-4522) ([#147](https://github.com/cachekit-io/cachekit-ts/issues/147)) ([7d74c6b](https://github.com/cachekit-io/cachekit-ts/commit/7d74c6bccf2e5b0d6825b85f757d4d42eaa40a21))
* **l1:** hold an unstorable SWR refresh off without taking a refresh slot (LAB-7811) ([#197](https://github.com/cachekit-io/cachekit-ts/issues/197)) ([88a8a3c](https://github.com/cachekit-io/cachekit-ts/commit/88a8a3c6692342922b3e1bd457635b59798298d1))
* **l1:** never admit an entry charged above maxMemory (LAB-7729) ([#194](https://github.com/cachekit-io/cachekit-ts/issues/194)) ([d6e35d4](https://github.com/cachekit-io/cachekit-ts/commit/d6e35d41c6a1220610a8baab5407e9cf25ca0e2e))
* **l1:** reject a non-finite or non-positive maxMemory (LAB-8011) ([#207](https://github.com/cachekit-io/cachekit-ts/issues/207)) ([7155d43](https://github.com/cachekit-io/cachekit-ts/commit/7155d434207e055d20275313957a87b530dd68e6))
* **logger:** report a rejecting async logger instead of leaking it (LAB-8278) ([#220](https://github.com/cachekit-io/cachekit-ts/issues/220)) ([cf30cf4](https://github.com/cachekit-io/cachekit-ts/commit/cf30cf49bb6ca1527ef5ab3f15707eb3e187ff9a))
* **memcached:** bound every op with a deadline so a stalled server cannot hang it (LAB-7156) ([#174](https://github.com/cachekit-io/cachekit-ts/issues/174)) ([ed32184](https://github.com/cachekit-io/cachekit-ts/commit/ed32184d23a69da6d72b3c4b62490403dcc0eff1))
* **memcached:** reject keys over 250 bytes before sending (LAB-5226) ([917cfc1](https://github.com/cachekit-io/cachekit-ts/commit/917cfc1d8669498a1712c570a7c6a80916801be2))
* **memcached:** report a failed memjs load once per backend (LAB-7548) ([#189](https://github.com/cachekit-io/cachekit-ts/issues/189)) ([4c2f755](https://github.com/cachekit-io/cachekit-ts/commit/4c2f75518173d25b74be8aefb63e055400231ebc))
* **reliability:** don't retry or count permanent backend errors toward the breaker (LAB-5215) ([#139](https://github.com/cachekit-io/cachekit-ts/issues/139)) ([49f0954](https://github.com/cachekit-io/cachekit-ts/commit/49f0954a3c45efc91232ccaf857799a4142714b5))
* **security:** store ciphertext in L1 for encrypted caches (LAB-238) ([#104](https://github.com/cachekit-io/cachekit-ts/issues/104)) ([0b1b2f8](https://github.com/cachekit-io/cachekit-ts/commit/0b1b2f8d55768ed6fb31a17a067b5da998feff33))
* **serialization:** bound msgpack decode at all untrusted call sites (LAB-281) ([#111](https://github.com/cachekit-io/cachekit-ts/issues/111)) ([19ad90c](https://github.com/cachekit-io/cachekit-ts/commit/19ad90c5c9d3208a7a74a46e3a1da680cca8f4d9))
* **serialization:** bound msgpack decode nesting depth before allocation (LAB-2487) ([#112](https://github.com/cachekit-io/cachekit-ts/issues/112)) ([906942d](https://github.com/cachekit-io/cachekit-ts/commit/906942d6ccaa130e3bdfba9cd4c90762ecc32de0))
* **serialization:** cache Uint8Array values as msgpack bin; binary key args hash by bytes (LAB-4839) ([#134](https://github.com/cachekit-io/cachekit-ts/issues/134)) ([be40638](https://github.com/cachekit-io/cachekit-ts/commit/be40638d131877a6ab0d9f97a99ce1b425398710))
* **serialization:** reject maxDepth outside the protocol's 32-1024 decode bound (LAB-3478) ([#167](https://github.com/cachekit-io/cachekit-ts/issues/167)) ([6a4d074](https://github.com/cachekit-io/cachekit-ts/commit/6a4d0749e1222e1e7766b9eaa68a1d40cbdfc92c))
* **serialization:** reject non-integer serializer size bounds; validate config before opening the backend (LAB-6965) ([#168](https://github.com/cachekit-io/cachekit-ts/issues/168)) ([2b81c3e](https://github.com/cachekit-io/cachekit-ts/commit/2b81c3ea9a40a05474c1a9e56424a3b5404301e4))
* **workers-kv:** always issue kv.delete in delete() (LAB-8103) ([#219](https://github.com/cachekit-io/cachekit-ts/issues/219)) ([86a2153](https://github.com/cachekit-io/cachekit-ts/commit/86a21538de692bc312d19f71cb5f429c581528c8))
* **workers:** keep compression on by default for the Cache API backend (LAB-5126) ([#137](https://github.com/cachekit-io/cachekit-ts/issues/137)) ([ada34a8](https://github.com/cachekit-io/cachekit-ts/commit/ada34a8bed16c280d44d1deb58f84e5440f15c1a))


### Performance Improvements

* **cachekit:** load ioredis with the Redis backend and prom-client off the op path (LAB-7081) ([#186](https://github.com/cachekit-io/cachekit-ts/issues/186)) ([a44d32e](https://github.com/cachekit-io/cachekit-ts/commit/a44d32eeda8fe949d03303ec698c10454636fc14))
* **core-bindings:** return NAPI results as copied Uint8Arrays (LAB-7084) ([#171](https://github.com/cachekit-io/cachekit-ts/issues/171)) ([460a15f](https://github.com/cachekit-io/cachekit-ts/commit/460a15fe0978a6d6a3a8cf75bfad95841dd2ce57))
* **core-wasm:** build at opt-level 3 with simd128 (LAB-7083) ([#169](https://github.com/cachekit-io/cachekit-ts/issues/169)) ([47d1ea3](https://github.com/cachekit-io/cachekit-ts/commit/47d1ea3a707bd98099576679f2aa5890060cdab6))
* **l1:** O(1) LRU eviction, serialized-size hint, pooled jitter randomness (LAB-7082) ([#190](https://github.com/cachekit-io/cachekit-ts/issues/190)) ([0648888](https://github.com/cachekit-io/cachekit-ts/commit/06488886c9bf5873edd725ab2364a87245355b48))
* **lock:** skip the uncontended double-check, waitUntil the release, re-check before fall-through (LAB-7119) ([#209](https://github.com/cachekit-io/cachekit-ts/issues/209)) ([7bd3877](https://github.com/cachekit-io/cachekit-ts/commit/7bd3877140800153c0f3d67433f38ce6836a7b32))
* **memcached:** default memjs to one try per cache attempt (LAB-7078) ([#187](https://github.com/cachekit-io/cachekit-ts/issues/187)) ([f00b465](https://github.com/cachekit-io/cachekit-ts/commit/f00b4658f979a5f27f6b44f6bb9288a95eef7962))

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
