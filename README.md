# @cachekit-io/cachekit

[![npm](https://img.shields.io/npm/v/@cachekit-io/cachekit.svg)](https://www.npmjs.com/package/@cachekit-io/cachekit) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

TypeScript SDK for CacheKit — backend-agnostic caching with L1 in-memory, SWR, circuit breaker, and optional zero-knowledge encryption.

> [!NOTE]
> **Status: beta** — CacheKit is in closed beta ahead of 1.0. APIs are stabilising; minor breaking changes may still occur between 0.x releases.

## Requirements

- Node.js 22+ (Node entrypoint) or Cloudflare Workers (workerd). The CommonJS build (`require()`) needs Node.js 22.12+, because it loads the ESM-only `@noble/hashes` through `require(esm)`
- Redis 6+ (Node Redis backends)

## Installation

```bash
npm install @cachekit-io/cachekit
```

Works with Redis, Memcached, File, Workers KV, or CacheKit Cloud. The full README, with the quick start, configuration and API reference, is the package's own: [packages/cachekit/README.md](packages/cachekit/README.md).

## Packages

| Package                                                          | Description                          |
| ---------------------------------------------------------------- | ------------------------------------ |
| [@cachekit-io/cachekit](./packages/cachekit)                     | Main SDK (Node + Cloudflare Workers) |
| [@cachekit-io/cachekit-core-ts](./packages/cachekit-core-ts)     | Native bindings (N-API, Node)        |
| [@cachekit-io/cachekit-core-wasm](./packages/cachekit-core-wasm) | wasm32 bindings (Cloudflare Workers) |

**Live example**: [Skyline](https://github.com/cachekit-io/bluesky-thinking) — this SDK serving
Bluesky firehose analytics from a Cloudflare Workers edge API, reading cache entries written live
by the Python SDK on one shared interop namespace.

## Architecture

```
cachekit-ts/
├── packages/
│   ├── cachekit/           # TypeScript SDK
│   │   ├── src/
│   │   │   ├── cache.ts          # Core cache implementation
│   │   │   ├── intents.ts        # Intent-based API (.minimal, .production, .secure, .io)
│   │   │   ├── backends/         # Redis, CacheKit Cloud, Memcached, File backends
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

## Documentation

- [Quickstart](https://docs.cachekit.io/typescript/quickstart/)
- [Cloudflare Workers quickstart](https://docs.cachekit.io/typescript/workers-quickstart/)
- [Backends reference](https://docs.cachekit.io/typescript/reference/backends/)
- [Cache reference](https://docs.cachekit.io/typescript/reference/cache/)
- [Configuration reference](https://docs.cachekit.io/typescript/reference/configuration/)
- [Protocol specification](https://github.com/cachekit-io/protocol)

### In this repository

- [Package README](packages/cachekit/README.md)
- [Changelog](packages/cachekit/CHANGELOG.md)
- [Security policy](SECURITY.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for building from source, running the tests and benchmarks, and sending a change.

## License

MIT
