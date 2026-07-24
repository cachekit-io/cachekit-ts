# @cachekit-io/cachekit

Production-ready Redis caching for TypeScript/Node.js. Hybrid TypeScript-Rust design with L1 in-memory cache, SWR, circuit breaker, and optional client-side encryption.

> **Version note**: 0.1.1 was tagged in git but never published to npm (a CI auth bug, fixed in #45). Published versions on npm jump 0.1.0 → 0.1.2. If you're pinning, use 0.1.2 or later.

## Features

- **Dual-layer caching**: L1 in-memory (~50ns) + pluggable L2 (Redis, CacheKit SaaS, Memcached, local File)
- **Stale-while-revalidate**: Serve stale data while refreshing in background
- **Zero-knowledge encryption**: Optional AES-256-GCM client-side encryption
- **Circuit breaker**: Automatic failure isolation with exponential backoff
- **TypeScript-first**: Full type safety with strict mode
- **Cross-language compatible**: Protocol v1.0 compatible with Python SDK

## Installation

```bash
npm install @cachekit-io/cachekit
# or
pnpm add @cachekit-io/cachekit
```

## Quick Start

```typescript
import { createCache } from '@cachekit-io/cachekit';

// Create a production cache in one line
const cache = createCache.production({ url: 'redis://localhost:6379' });

// Direct key-value operations
await cache.set('user:123', { name: 'Alice', email: 'alice@example.com' });
const user = await cache.get('user:123');

// Function caching with wrap()
const getUser = cache.wrap(
  async (id: number) => {
    return db.users.findUnique({ where: { id } });
  },
  { namespace: 'users:getUser', ttl: 3600 }
);

// Cached - computes on first call, returns from cache after
const user = await getUser(123);

// Cleanup
await cache.close();
```

## Intent-Based API

Instead of manually wiring backends, reliability, and encryption, declare what you want:

```typescript
import { createCache } from '@cachekit-io/cachekit';

// Speed-first — no circuit breaker, no retry (product catalogs, public APIs)
const fast = createCache.minimal({
  url: 'redis://localhost:6379',
  ttl: 300,
});

// Reliability-first — circuit breaker + retry + degradation (production services)
const reliable = createCache.production({
  url: 'redis://localhost:6379',
  ttl: 600,
});

// Zero-knowledge encryption — production reliability + AES-256-GCM (PII, GDPR)
const encrypted = createCache.secure({
  url: 'redis://localhost:6379',
  masterKey: process.env.CACHEKIT_MASTER_KEY!, // or set CACHEKIT_MASTER_KEY env var
});

// SaaS backend — zero infrastructure via cachekit.io
const managed = createCache.io({
  apiKey: process.env.CACHEKIT_API_KEY!, // or set CACHEKIT_API_KEY env var
  ttl: 3600,
});
```

Each intent pre-configures the full stack with sensible defaults:

| Intent       | Backend     | Circuit Breaker   | Retry | L1 SWR | Encryption  | Default TTL |
| ------------ | ----------- | ----------------- | ----- | ------ | ----------- | ----------- |
| `minimal`    | Redis       | Off               | Off   | Off    | No          | 300s        |
| `production` | Redis       | On (threshold: 5) | On    | On     | No          | 600s        |
| `secure`     | Redis       | On (threshold: 5) | On    | On     | AES-256-GCM | 600s        |
| `io`         | cachekit.io | On (threshold: 5) | On    | On     | Optional    | 3600s       |

All defaults are overridable — pass `reliability`, `l1`, or `metrics` to customize.

## Manual Configuration

The original `createCache(options)` API is still available for full control:

```typescript
const cache = createCache({
  // Required: Redis backend
  backend: {
    url: 'redis://localhost:6379',
    keyPrefix: 'myapp:',
  },

  // Default TTL in seconds
  defaultTtl: 3600,

  // L1 in-memory cache (enabled by default)
  l1: {
    enabled: true,
    maxEntries: 1000,
    maxMemory: 50 * 1024 * 1024, // 50MB
  },

  // Optional: Client-side encryption
  encryption: {
    masterKey: process.env.CACHEKIT_MASTER_KEY!, // hex-encoded, 32+ bytes
    tenantId: 'tenant-123', // for multi-tenant key isolation
  },

  // Reliability settings
  reliability: {
    circuitBreaker: {
      failureThreshold: 10,
      timeout: 5000,
    },
    retry: {
      maxAttempts: 3,
      baseDelay: 100,
    },
  },
});
```

## Backends

Four backends implement the same `Backend` interface (raw bytes in/out) and plug into `createCache({ backend })` interchangeably:

| Backend           | Import                                                      | Runtime    | Notes                                                                                |
| ----------------- | ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Redis             | `redis` from `@cachekit-io/cachekit`                        | Node       | ioredis; TTL inspection + distributed locking                                        |
| CachekitIO (SaaS) | `cachekitio` from `@cachekit-io/cachekit`                   | Node, edge | fetch-based; TTL + locking variants                                                  |
| Memcached         | `memcached` from `@cachekit-io/cachekit/backends/memcached` | Node       | memjs (binary protocol, multi-server); requires the optional `memjs` peer dependency |
| File              | `file` from `@cachekit-io/cachekit/backends/file`           | Node       | local disk, on-disk format shared with cachekit-py                                   |

The Memcached and File backends are **Node-runtime only** and live behind subpath exports, so browser/edge bundles that import the package root never pull in `memjs` or `node:fs`.

### Memcached

```typescript
// pnpm add memjs   (optional peer dependency, loaded lazily on first use)
import { createCache } from '@cachekit-io/cachekit';
import { memcached } from '@cachekit-io/cachekit/backends/memcached';

const backend = memcached({
  servers: ['mc1:11211', 'mc2:11211'], // default: ['127.0.0.1:11211']
  keyPrefix: 'myapp:',
});
const cache = createCache({ backend });
```

Semantics match cachekit-py's Memcached backend: TTLs are clamped to the 30-day protocol maximum (larger values would be read as unix timestamps), values over `maxItemSizeBytes` (default 1 MiB, the server's default item-size limit) are rejected client-side with a loud error, `exists()` is GET-based (memcached has no EXISTS command), and omitting `ttl` with no `defaultTtl` means never expire. `refreshTTL(key, ttl)` is available via the `touch` command, but there is no `getTTL` — the memcached protocol cannot read a key's remaining TTL, so this backend deliberately does not implement `TTLBackend`.

### File

```typescript
import { createCache } from '@cachekit-io/cachekit';
import { file } from '@cachekit-io/cachekit/backends/file';

const backend = file({
  cacheDir: '/var/cache/myapp', // default: os.tmpdir() + '/cachekit'
  defaultTtl: 3600, // default: 0 = never expire
});
const cache = createCache({ backend });
```

The on-disk format is shared with cachekit-py's File backend — filenames are `blake2b(key, digestSize=16)` hex and each file carries the same 14-byte header (magic, version, flags, big-endian expiry), so Python and TypeScript processes can point at the same cache directory. Writes are atomic (write-to-temp, fsync, rename), expired or corrupt entries are unlinked on read, and symlinks are rejected (`O_NOFOLLOW`). Implements `TTLBackend` (`getTTL`/`refreshTTL` read and rewrite the on-disk expiry header). Unlike cachekit-py there is no LRU size eviction yet — cap growth with TTLs. The shared format is specified in [cachekit-io/protocol](https://github.com/cachekit-io/protocol/blob/main/spec/file-backend-format.md): version-1 writers set reserved and flags to zero, and this backend fails closed on a future nonzero value (misses without deleting or exposing the payload). Positive fractional TTLs round up to one second so they never become the permanent-entry sentinel.

## API Reference

### createCache(options)

Create a configured cache instance.

### cache.get<T>(key)

Get a value by key. Returns `null` if not found.

### cache.set<T>(key, value, options?)

Set a value with optional TTL override.

```typescript
await cache.set('key', value, { ttl: 60, namespace: 'custom' });
```

### cache.delete(key)

Delete a key. Returns `true` if existed.

### cache.wrap(fn, options)

Wrap an async function with caching.

```typescript
const cachedFn = cache.wrap(async (id: number) => fetchData(id), {
  namespace: 'api:getData',
  ttl: 300,
});
```

### cache.invalidate(level, options?)

Invalidate cache entries.

```typescript
// Invalidate everything
await cache.invalidate('global');

// Invalidate a namespace
await cache.invalidate('namespace', { namespace: 'users' });

// Invalidate specific key
await cache.invalidate('params', { key: 'users:getUser:abc123...' });
```

### cache.close()

Close connections and release resources.

## Error Handling

```typescript
import {
  CachekitError,
  BackendError,
  EncryptionError,
  CircuitBreakerOpenError,
  TimeoutError,
} from '@cachekit-io/cachekit';

try {
  await cache.get('key');
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    // Backend is unhealthy, serve degraded response
  } else if (error instanceof BackendError) {
    // Redis operation failed
  }
}
```

## Observability

Optional Prometheus metrics via peer dependency:

```bash
npm install prom-client
```

```typescript
const cache = createCache({
  backend: { url: 'redis://localhost:6379' },
  metrics: true, // Enable Prometheus metrics
});

// Metrics: cachekit_operations_total, cachekit_hits_total, cachekit_misses_total,
//          cachekit_errors_total, cachekit_operation_duration_seconds
```

## Cloudflare Workers

The SDK ships a Workers-native entrypoint: `@cachekit-io/cachekit/workers`
(bare `import '@cachekit-io/cachekit'` also resolves to it under wrangler via
the `workerd` export condition). It needs **no `nodejs_compat` flag** — the
bundle contains no `node:*` builtins, no native addons, no ioredis, and no
prom-client. Crypto (AES-256-GCM + HKDF-SHA256, counter nonces) and the
ByteStorage wire envelope (LZ4 + xxHash3-64) run on a wasm32 build of the
same audited Rust core the Node SDK uses (`@cachekit-io/cachekit-core-wasm`,
~55 KB gzipped), so ciphertexts and envelopes are byte-compatible across
Node, Workers, Python, and Rust.

```typescript
import { createCache, type WorkersCache } from '@cachekit-io/cachekit/workers';

// One cache per isolate — see the note below.
let cache: WorkersCache | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    cache ??= createCache.io({
      apiKey: env.CACHEKIT_API_KEY, // explicit config — no process.env needed
      encryption: { masterKey: env.CACHEKIT_MASTER_KEY }, // optional zero-knowledge mode
      ttl: 300,
    });

    // Bind THIS request's context: SWR background refreshes then ride
    // ctx.waitUntil and survive past the response. A cheap request-scoped
    // view over the singleton — same encryptor, same L1.
    const requestCache = cache.withExecutionContext(ctx);

    const getAnswer = requestCache.wrap(async () => computeExpensiveThing(), {
      namespace: 'api:answer',
      ttl: 300,
    });

    return Response.json(await getAnswer());
  },
};
```

> **Create the cache once per isolate, not per request.** Reusing one cache
> keeps a single encryptor whose monotonic counter guarantees nonce
> uniqueness; per-request caches each start a fresh encryptor whose
> uniqueness rests on a random 64-bit instance id (a weaker, birthday-bounded
> guarantee at very high request volumes) and leave wasm allocations behind
> on hot isolates. If you do create short-lived caches, call `cache.close()`
> — it zeroizes key material and frees the wasm codec deterministically.

**Workers surface (deltas vs Node):**

- **Backends**: CachekitIO (`createCache.io` / `backend: { apiKey }`) or a
  custom `Backend` instance. The Redis-URL intents (`minimal`, `production`,
  `secure`) throw `ConfigurationError` — ioredis is TCP and Node-only.
- **No cross-instance invalidation** (Redis Pub/Sub is Node-only); L1
  invalidation within an isolate works as usual.
- **SWR needs the request context** — workerd cancels fire-and-forget work
  when the response returns, so background refreshes only schedule through
  a view bound with `cache.withExecutionContext(ctx)` (they're registered
  via `ctx.waitUntil` and run to completion). Wrap functions through the
  bound view inside the fetch handler, as above; functions wrapped on the
  base cache still work but fall back to plain (no-SWR) L1 reads — entries
  expire and recompute in the request path instead.
- **No Prometheus metrics.**
- **Key material semantics**: keys are derived and held in wasm linear
  memory, which is a host-readable `ArrayBuffer` — weaker isolation than the
  NAPI Rust heap on Node. On Workers, the host is your own isolate, making
  this roughly JS-heap-equivalent in threat model; `dispose()`/`close()`
  still zeroizes deterministically.
- **Startup**: wasm instantiation is a small one-time cost per isolate
  (~150 KB module, no I/O).

## Requirements

- Node.js 22+ (Node entrypoint) or Cloudflare Workers (workerd)
- Redis 6+ (Node Redis backends)

## License

MIT
