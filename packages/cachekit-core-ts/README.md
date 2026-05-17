# @cachekit-io/cachekit-core-ts

Native Rust bindings for [`@cachekit-io/cachekit`](https://www.npmjs.com/package/@cachekit-io/cachekit). Provides byte-storage (LZ4 + xxHash3), HKDF key derivation, and AES-256-GCM encryption primitives via N-API.

> **Version note**: 0.1.1 was tagged in git but never published to npm (a CI flag-rename bug in @napi-rs/cli v3, fixed in #51). Published versions on npm jump 0.1.0 → 0.1.2. If you're pinning, use 0.1.2 or later.

## Installation

You shouldn't need to install this directly — it's a peer of `@cachekit-io/cachekit`. Installing the main SDK pulls in the right platform binary automatically:

```bash
npm install @cachekit-io/cachekit
```

## Platform support

Prebuilt binaries are shipped via per-platform npm packages, selected at install time by the `optionalDependencies` mechanism:

| Platform              | Target                      | Package                                         |
| --------------------- | --------------------------- | ----------------------------------------------- |
| Linux x86_64 (glibc)  | `x86_64-unknown-linux-gnu`  | `@cachekit-io/cachekit-core-ts-linux-x64-gnu`   |
| Linux aarch64 (glibc) | `aarch64-unknown-linux-gnu` | `@cachekit-io/cachekit-core-ts-linux-arm64-gnu` |
| macOS x86_64          | `x86_64-apple-darwin`       | `@cachekit-io/cachekit-core-ts-darwin-x64`      |
| macOS arm64           | `aarch64-apple-darwin`      | `@cachekit-io/cachekit-core-ts-darwin-arm64`    |
| Windows x86_64 (MSVC) | `x86_64-pc-windows-msvc`    | `@cachekit-io/cachekit-core-ts-win32-x64-msvc`  |

If your platform isn't listed, the package will fail to load at runtime. Open an issue if you need an additional target.

## API surface

Public exports (consumed by `@cachekit-io/cachekit`):

- `ByteStorage` — LZ4 compression + xxHash3-64 integrity envelope
- `TenantKeys` — HKDF-SHA256 per-tenant derived keys with `ZeroizeOnDrop`
- `deriveKey` — single-domain HKDF key derivation
- `encrypt` / `decrypt` — AES-256-GCM with AAD binding
- `version` — version string from the underlying Cargo crate

See the [main SDK README](https://www.npmjs.com/package/@cachekit-io/cachekit) for usage; this package isn't intended for direct consumption.

## Requirements

- Node.js 22+

## License

MIT
