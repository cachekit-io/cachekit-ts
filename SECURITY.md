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
reads the envelope's MessagePack header. An envelope that
declares an `original_size` over `maxDecodedSize` is rejected with
`ValueTooLargeError`. So is input too long to be an envelope within that
ceiling. Bytes are never unpacked when their header is not in a shape a
conforming writer emits, when core's own caps would refuse them, or when
`compressed_data` is longer than LZ4's worst case for the declared size. That
last check stops a small declared size from carrying a large payload into core's
copy. A compression-on read treats such bytes as corrupt. The envelope-tolerant
read on a compression-off cache decodes them as plain MessagePack. What `unpack`
may allocate is then a small multiple of `maxDecodedSize`: the input, the
compressed payload, and an output of at most `maxDecodedSize`, which is the same
bound `serializer.decode` applies to its input. On an encrypted cache the
ciphertext is bounded first: bytes longer than any plaintext the cache would
decode, plus the 28-byte AES-GCM nonce and tag, are rejected with
`ValueTooLargeError` before `decrypt` copies them. The envelope-tolerant read
also decodes as plain MessagePack an envelope that passed the header read but
that core rejects (checksum or shape mismatch), and reports it through the SDK
logger as a rate-limited `[cachekit] envelope-shaped value failed verified
unpack` line carrying the key's digest. The line never includes core's error
text: on an encrypted cache those bytes are decrypted plaintext.

One consequence on compression-off caches: a plain value whose MessagePack
exactly mimics an envelope core would decompress, and which declares more than
`maxDecodedSize`, is refused rather than decoded. Only decompressing could tell
it from a real oversized envelope, and serving a real one as its raw 4-tuple
would be silent corruption. That key reads as a miss, or throws with degradation
off. The shape required is `[bytes, [8 integers ≤ 255], an integer over
maxDecodedSize, anything]`, with at least one byte per 1000 of that integer.

If an allocation fails or the wasm instance traps inside `unpack` during the
envelope-tolerant read, the SDK propagates the error instead of treating it as
"not an envelope": on Workers a trap leaves that wasm instance unusable. On
Node, a native allocation failure inside the NAPI binding aborts the process
before any JavaScript can observe it; `maxDecodedSize` is what keeps a forged
envelope from getting that far.

> [!IMPORTANT]
> The 512 MiB core ceiling is server-class. A Cloudflare Workers isolate has
> roughly 128 MiB. On Workers, `maxDecodedSize` is now the setting that bounds
> what a forged envelope can make the reader allocate during `unpack`. It does
> not bound the decoded value's heap, which can be many times larger; size it
> as the [README's value size limits](packages/cachekit/README.md#value-size-limits--the-1-mib-default-is-a-cache-off-switch-not-a-suggestion)
> describe. Making core's ceiling environment-aware is tracked in LAB-2505.
