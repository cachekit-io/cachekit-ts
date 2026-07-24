# cachekit-ts

TypeScript SDK for CacheKit - Production-ready Redis caching with L1 in-memory, SWR, and zero-knowledge encryption.

## Packages

| Package                                                          | Description                          |
| ---------------------------------------------------------------- | ------------------------------------ |
| [@cachekit-io/cachekit](./packages/cachekit)                     | Main SDK (Node + Cloudflare Workers) |
| [@cachekit-io/cachekit-core-ts](./packages/cachekit-core-ts)     | Native bindings (N-API, Node)        |
| [@cachekit-io/cachekit-core-wasm](./packages/cachekit-core-wasm) | wasm32 bindings (Cloudflare Workers) |

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
│   │   │   ├── backends/         # Redis, CachekitIO, Memcached, File backends
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
