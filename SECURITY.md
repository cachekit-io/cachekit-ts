# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in CacheKit, please report it responsibly.

**Do not open a public issue.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/cachekit-io/cachekit-ts/security/advisories/new) to submit your report. We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Cache-Key Path Encoding (CWE-22)

The CachekitIO backend transmits cache keys as a single URL path segment (`/v1/cache/{key}`, `…/{key}/ttl`, `…/{key}/lock`). Keys are percent-encoded with `encodeURIComponent`; a key that is exactly `.`, `..`, `health`, `ttl` or `lock` is rejected with a `ConfigurationError` before any request is built ([protocol `spec/saas-api.md` § Cache-Key Path Encoding](https://github.com/cachekit-io/protocol/blob/main/spec/saas-api.md#cache-key-path-encoding), rule 2): the WHATWG URL parser behind `fetch` removes literal and percent-encoded (`%2E`) dot segments before the request reaches the wire, and the other three words are live route tokens at that path level. Every other key — including `a:..` and every canonical `ns:…` key — is sent percent-encoded as a single path segment and decodes once server-side to the original key.

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

The SDK holds envelopes to its own, lower ceiling as well:
`serializer.maxDecodedSize` (10 MiB by default). Before calling `unpack`, it
reads the envelope's declared `original_size` from the MessagePack header and
rejects any envelope that declares more than `maxDecodedSize` with
`ValueTooLargeError`. The codec never sees it, so nothing is allocated for it.
This covers both read paths: compression-on reads, and the envelope-tolerant
read on a compression-off cache. Bytes whose header is not in a shape a
conforming writer emits are never unpacked. A compression-on read treats them as
corrupt, and the tolerant read decodes them as plain MessagePack. Whatever
`unpack` returns is therefore at most `maxDecodedSize`, the same bound
`serializer.decode` applies, so one setting governs both stages.

If an allocation fails or the wasm instance traps inside `unpack` during the
envelope-tolerant read, the SDK propagates the error instead of treating it as
"not an envelope": on Workers a trap leaves that wasm instance unusable. On
Node, a native allocation failure inside the NAPI binding aborts the process
before any JavaScript can observe it; `maxDecodedSize` is what keeps a forged
envelope from getting that far.

> [!IMPORTANT]
> The 512 MiB core ceiling is server-class. A Cloudflare Workers isolate has
> roughly 128 MiB, so keep `maxDecodedSize` within what the isolate can afford
> on a single read: it bounds what a forged envelope can make the reader
> allocate, not just what the decoder accepts. Making
> core's ceiling environment-aware is tracked in LAB-2505.
