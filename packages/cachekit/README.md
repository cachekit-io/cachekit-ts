# @cachekit-io/cachekit

Production-ready Redis caching for TypeScript/Node.js. Hybrid TypeScript-Rust design with L1 in-memory cache, SWR, circuit breaker, and optional client-side encryption.

## Features

- **Dual-layer caching**: L1 in-memory (~50ns) + L2 Redis (~2-50ms)
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

## Requirements

- Node.js 18+
- Redis 6+

## License

MIT
