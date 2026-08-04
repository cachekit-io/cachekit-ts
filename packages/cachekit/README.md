# @cachekit-io/cachekit

Backend-agnostic caching for TypeScript/Node.js — works with Redis, Memcached, File, Workers KV, or CachekitIO. Hybrid TypeScript-Rust design with L1 in-memory cache, SWR, circuit breaker, and optional zero-knowledge encryption.

> **Version note**: 0.1.1 was tagged in git but never published to npm (a CI auth bug, fixed in #45). Published versions on npm jump 0.1.0 → 0.1.2. If you're pinning, use 0.1.2 or later.

## Features

- **Dual-layer caching**: L1 in-memory (~50ns) + pluggable L2 (Redis, CachekitIO, Memcached, local File)
- **Stale-while-revalidate**: Serve stale data while refreshing in background
- **Stampede protection**: Cold-miss single-flight per process (always on) + opt-in cross-process distributed locks
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

## Stampede Protection

A cold cache key hit by N concurrent callers would normally execute the wrapped
function N times and issue N backend reads — on the metered-misses SaaS backend
that is N billed misses for one key.

**In-process single-flight is always on**: concurrent `wrap()` calls for the
same cache key share one in-flight promise, so the herd costs one L2 read, one
compute, and one write. If the flight fails, every waiting caller receives the
same rejection and the next call retries fresh.

**Cross-process locking is opt-in** via `stampede.distributedLock`, for fleets
where many processes can go cold on the same key simultaneously. It mirrors
cachekit-py's flow: acquire the backend lock, double-check L2, compute, write,
release. Contested processes retry the lock on an interval (never polling
`get()` — on metered-misses backends a poll against a still-cold key is itself
a billed miss) and fall through to computing after `lockWaitMs`; the lock is
best-effort mitigation, never a correctness gate, so lock-endpoint failures
degrade to an unlocked compute.

```typescript
const cache = createCache({
  backend: { url: 'redis://localhost:6379' }, // Redis and CachekitIO backends support locks
  stampede: {
    distributedLock: true, // default false
    lockTimeoutMs: 30000, // lock lease; size at/above expected recompute time
    lockWaitMs: 5000, // max wait for the lock holder before computing anyway
    lockPollMs: 100, // lock retry interval while contested
  },
});
```

Requires a lock-capable backend: Redis, a `CachekitIOBackendConfig` (the SaaS
lock endpoint is selected automatically), `cachekitioWithLocking()`, or
`cachekitioFull()`. `createCache` throws `ConfigurationError` if
`distributedLock` is requested on a backend without `acquireLock`/`releaseLock`.

There is deliberately no general admission-control cap beyond L1's
`maxConcurrentRefreshes`: on Node's single-threaded event loop concurrent
misses don't compete for threads, single-flight collapses the per-key herd,
and distinct-key miss floods are already bounded by backend timeouts plus the
circuit breaker. A global semaphore would add queueing latency without a
failure mode it prevents.

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
  metrics: true, // or { prefix: 'myapp', defaultLabels: { env: 'prod' }, registry }
});

// Counters:   cachekit_operations_total{operation,status}, cachekit_hits_total{layer},
//             cachekit_misses_total, cachekit_errors_total{error_type}
// Histogram:  cachekit_operation_duration_seconds{operation}
// Gauges:     cachekit_l1_entries, cachekit_l1_memory_bytes, cachekit_circuit_breaker_state
```

If `metrics` is enabled but `prom-client` is not installed, the SDK reports the
failure once through the library logger and metrics degrade to no-ops — never
silently. (On Cloudflare Workers, where prom-client cannot run, the `metrics`
option degrades to a no-op the same way.)

Internal error reporting (background refresh, invalidation channel, Redis
connection events) defaults to `console.error`; route it into your own logging
pipeline with `setLogger`:

```typescript
import { setLogger } from '@cachekit-io/cachekit';

setLogger((message, error) => myLogger.warn({ error }, message));
setLogger(null); // restore the default
```

With the CachekitIO backend, the `X-CacheKit-L1-*` telemetry headers are wired
automatically from the cache's live L1/L2 hit and miss counters; pass your own
`metricsProvider` in the backend config to override.

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

### Native edge storage: Workers KV and the Cache API

Beyond CachekitIO, two Cloudflare-native backends keep cache state in the
edge itself — no round-trip to api.cachekit.io. Both store the same opaque
ByteStorage payloads as every other backend, so encryption and the wire
envelope are unchanged (secure caches store only ciphertext), and both plug
into `createCache` or any intent via `backend:`:

```typescript
import { createCache, workersKV, workersCacheAPI } from '@cachekit-io/cachekit/workers';

// Inside your fetch handler (env bindings arrive per-request; create the
// cache lazily once per isolate, as above):

// Workers KV: globally replicated, eventually consistent.
cache ??= createCache.production({
  backend: workersKV({ kv: env.CACHE_KV }), // your KVNamespace binding
  ttl: 600,
});

// Cache API: per-data-center read-through tier (caches.default or named).
popCache ??= createCache.minimal({
  backend: workersCacheAPI(), // or workersCacheAPI({ cacheName: 'my-cache' })
  ttl: 60,
});
```

TTL and consistency semantics differ from Redis/CachekitIO — pick by workload:

|                          | Workers KV (`workersKV`)                                                            | Cache API (`workersCacheAPI`)                                     |
| ------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Scope                    | Global (all locations, eventually consistent — writes take up to ~60s to propagate) | Single data center only                                           |
| TTL                      | Native `expirationTtl`; **60s minimum** — shorter TTLs are clamped up, never down   | `Cache-Control: max-age`, honored to the second, no floor         |
| `ttl <= 0` ("no expiry") | Stored without expiration                                                           | Capped at 1-year max-age (the Cache API has no unbounded storage) |
| Eviction                 | Durable until expiry                                                                | Best-effort — entries may be dropped under cache pressure         |
| Best for                 | Shared config, sessions, rarely-written hot reads                                   | Request-local acceleration in front of a shared source            |

The Cache API is request-keyed under the hood; the backend maps each cache
key to a synthetic never-fetched URL, so it behaves like a plain KV store
from the SDK's perspective. Treat it as an accelerator tier, not
authoritative storage. `delete()` on KV derives its boolean from a
read-then-delete (KV's own delete is void), so it is advisory under
concurrent writers.

> **Cache API caveats.** `caches.default` requires a Worker on a **route or
> custom domain** — it is a silent no-op on `*.workers.dev` and in the
> dashboard/Playground preview (writes are dropped, reads always miss, no
> error). It is also **zone-shared**: a co-located Worker can read entries you
> store unencrypted, so keep non-secure workloads on a **named cache**
> (`workersCacheAPI({ cacheName })`) or use `createCache.secure(...)`
> (ciphertext at rest). And because the Cache API re-encodes keys onto
> synthetic URLs (a key transform, not a prefix), it does **not** support
> cross-SDK **interop** mode — use Workers KV or CachekitIO for interop caches.

**Workers surface (deltas vs Node):**

- **Backends**: CachekitIO (`createCache.io` / `backend: { apiKey }`),
  Workers KV (`workersKV`), the Cache API (`workersCacheAPI`), or a custom
  `Backend` instance. The Redis-URL intents (`minimal`, `production`,
  `secure` with `url`) throw `ConfigurationError` — ioredis is TCP and
  Node-only.
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
