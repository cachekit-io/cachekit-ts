# cachekit-ts

TypeScript SDK for CacheKit - Production-ready Redis caching with L1 in-memory, SWR, and zero-knowledge encryption.

## Status

**Pre-1.0 (`0.1.x`) — API surface is not yet stable.** Breaking changes may land in any minor bump until `1.0.0`. Pin to a published version; do not track `main` in production.

`main` is the integration branch and is not guaranteed stable between releases:

- Per-PR CI builds only `x86_64-unknown-linux-gnu` for the native crate (see `.github/workflows/build-native.yml`). The full 5-target matrix (linux x64/arm64, macOS x86/arm64, Windows) runs on `push: main` and on release tags — cross-platform regressions can therefore land on `main` and stay there until the post-merge run catches them.
- Release tags (`cachekit-core-ts-v*`, `cachekit-v*`) are only cut after the full matrix passes on `main`, so published artifacts are validated against every supported platform.

If you need a stable target, depend on a published release on npm.

## Packages

| Package                                                      | Description             |
| ------------------------------------------------------------ | ----------------------- |
| [@cachekit-io/cachekit](./packages/cachekit)                 | Main SDK                |
| [@cachekit-io/cachekit-core-ts](./packages/cachekit-core-ts) | Native bindings (N-API) |

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint
pnpm lint
```

## Architecture

```
cachekit-ts/
├── packages/
│   ├── cachekit/           # TypeScript SDK
│   │   ├── src/
│   │   │   ├── cache.ts          # Core cache implementation
│   │   │   ├── intents.ts        # Intent-based API (.minimal, .production, .secure, .io)
│   │   │   ├── backends/         # Redis backend
│   │   │   ├── l1/               # In-memory LRU cache
│   │   │   ├── reliability/      # Circuit breaker, retry
│   │   │   ├── encryption/       # Encryption manager
│   │   │   ├── serialization/    # MessagePack + key gen
│   │   │   └── invalidation/     # Redis pub/sub
│   │   └── test/
│   │       ├── integration/      # Redis integration tests
│   │       └── protocol/         # Protocol v1.0 compliance
│   │
│   └── cachekit-core-ts/   # Rust N-API bindings
│       ├── src/lib.rs            # ByteStorage, Encryptor, KeyRotation
│       └── Cargo.toml
│
├── .github/workflows/      # CI/CD
├── turbo.json              # Build orchestration
└── pnpm-workspace.yaml
```

## License

MIT
