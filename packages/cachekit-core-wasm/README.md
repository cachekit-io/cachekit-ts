# @cachekit-io/cachekit-core-wasm

wasm32 build of [cachekit-core](https://github.com/cachekit-io/cachekit-core)
for Cloudflare Workers — LZ4 compression + xxHash3-64 integrity (the
ByteStorage wire envelope) and AES-256-GCM + HKDF-SHA256 zero-knowledge
encryption with counter nonces, byte-compatible with every other CacheKit SDK.

This is the Workers sibling of
[`@cachekit-io/cachekit-core-ts`](../cachekit-core-ts) (the NAPI binding for
Node): same pinned Rust crate, same API surface (`deriveTenantKeys`,
`encryptWithTenantKeys`, `decryptWithTenantKeys`, `ByteStorage`), one
deterministic `wasm32-unknown-unknown` target instead of a per-platform
native matrix. The artifact is ~137 KB raw / ~55 KB gzipped plus ~10 KB of
wasm-bindgen glue — about 2% of the free-plan Worker size budget.

Most users never install this directly — it is a dependency of
[`@cachekit-io/cachekit`](../cachekit)'s `/workers` entrypoint.

## Usage

Workers-only. The `.wasm` import resolves through wrangler's `CompiledWasm`
module rule; plain Node cannot load this package (use the NAPI sibling).

```js
import {
  ensureInitialized,
  deriveTenantKeys,
  encryptWithTenantKeys,
  decryptWithTenantKeys,
  ByteStorage,
} from '@cachekit-io/cachekit-core-wasm';

ensureInitialized(); // synchronous, idempotent, one-time per isolate

const tenantKeys = deriveTenantKeys(masterKeyBytes, 'tenant-123');
const ciphertext = encryptWithTenantKeys(plaintext, aad, tenantKeys);
const plaintext2 = decryptWithTenantKeys(ciphertext, aad, tenantKeys);
tenantKeys.free(); // zeroizes key material deterministically
```

## Security notes

- Keys derived by `deriveTenantKeys` stay inside wasm linear memory and are
  zeroized on `free()` (or by the FinalizationRegistry as a backstop).
  Linear memory is a host-readable `ArrayBuffer`, so this is weaker isolation
  than the NAPI binding's Rust heap — on Workers the host is your own
  isolate, making it roughly JS-heap-equivalent in threat model.
- Each `TenantKeys` handle owns one encryptor with a counter nonce (unique
  instance id + monotonic counter, exhaustion at 2^32) — the same
  nonce-reuse guarantees as the native core. Reuse one handle per key; do
  not derive multiple handles for the same key material and interleave
  encryptions.

## Building

```bash
# prerequisites: rustup target wasm32-unknown-unknown,
# wasm-bindgen CLI at the version pinned in Cargo.lock, binaryen (wasm-opt)
pnpm build:wasm
```

The build script asserts the wasm-bindgen CLI matches the crate's pinned
version, enforces the < 100 KB gzipped size budget, and checks the committed
`index.d.ts` against the generated API surface.
