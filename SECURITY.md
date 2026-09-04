# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CacheKit, please report it responsibly.

**Do not open a public issue.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/cachekit-io/cachekit-ts/security/advisories/new) to submit your report. We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Scope

This policy covers the `@cachekit-io/cachekit` and `@cachekit-io/cachekit-core-ts` packages. For issues with the CacheKit SaaS platform (api.cachekit.io), contact security@cachekit.io.

## Bounded decompression

This SDK does not implement LZ4. `ByteStorage.unpack` in both bindings —
`cachekit-core-ts` (NAPI, native) and `cachekit-core-wasm` (Workers) — is a thin
wrapper over cachekit-core's `ByteStorage::retrieve` → `StorageEnvelope::extract`,
which bounds the decompressed output at `min(512 MiB, 1000 × compressed_len)`
_before_ decompressing. The envelope's self-declared `original_size` is not
trusted, and the xxHash3-64 checksum is unkeyed so it does not gate a forging
attacker — see [cachekit-core: Decompression limits](https://github.com/cachekit-io/cachekit-core/blob/main/SECURITY.md#decompression-limits).

`serializer.maxDecodedSize` (10 MiB by default) is checked inside
`serializer.decode`, i.e. on the already-decompressed bytes. It sits downstream
of core's bound rather than replacing it, so the two ceilings differ by ~51x:
core will materialize up to 512 MiB before `maxDecodedSize` is ever consulted.
Raising or lowering `maxDecodedSize` does not change what `unpack` may allocate.
Tracked in LAB-2732.

> [!IMPORTANT]
> The 512 MiB ceiling is server-class. A Cloudflare Workers isolate has roughly
> 128 MiB, so on the Workers build a payload well inside cachekit-core's limits
> can still exhaust the isolate. This SDK has no read-side pre-decompression
> bound, so the only lever is to check the fetched value's byte length yourself
> before handing it to the cache, or to cap value size at the backend. Making
> core's ceiling environment-aware is tracked in LAB-2505.
