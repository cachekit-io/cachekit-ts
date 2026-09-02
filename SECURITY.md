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

`serializer.maxDecodedSize` is checked on the already-decompressed bytes, so it
sits downstream of that bound rather than replacing it.

> [!IMPORTANT]
> The 512 MiB ceiling is server-class. A Cloudflare Workers isolate has roughly
> 128 MiB, so on the Workers build a payload well inside cachekit-core's limits
> can still exhaust the isolate. Bound payload size at the caller when running
> on Workers. Making the ceiling environment-aware is tracked in LAB-2505.
