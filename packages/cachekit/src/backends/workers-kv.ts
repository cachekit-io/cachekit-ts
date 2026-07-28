import { Backend } from './types.js';
import { BackendError, ConfigurationError } from '../errors.js';
import { classifyWorkersRuntimeError } from './error-classifier.js';
import { DEFAULT_TTL_SECONDS } from '../constants.js';

/**
 * Workers KV enforces a 60-second minimum on `expirationTtl`; shorter TTLs
 * are clamped up to this floor (never down — an entry may outlive a sub-60s
 * TTL, but never expire early).
 */
export const KV_MIN_TTL_SECONDS = 60;

/**
 * Minimal structural view of a Cloudflare Workers `KVNamespace` binding.
 *
 * Duck-typed so the SDK does not depend on `@cloudflare/workers-types` —
 * the binding from your Worker's `env` is assignable as-is.
 */
export interface KVNamespaceLike {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Configuration for the Workers KV backend.
 *
 * @example
 * ```typescript
 * const backend = workersKV({ kv: env.CACHE_KV });
 * ```
 */
export interface WorkersKVBackendConfig {
  /** The `KVNamespace` binding from your Worker's `env` (required). */
  kv: KVNamespaceLike;
  /** Default TTL in seconds for set operations without explicit TTL */
  defaultTtl?: number;
}

/**
 * Workers KV backend — stores opaque bytes in a Cloudflare Workers
 * `KVNamespace` binding. Cloudflare-Workers-only (`/workers` entrypoint).
 *
 * Encryption-agnostic: like every backend this sits below serialization /
 * envelope / encryption, so secure caches store only ciphertext in KV.
 *
 * Semantics vs Redis/CachekitIO (documented in the README Workers section):
 * - TTL floor: KV's `expirationTtl` minimum is 60s; shorter TTLs are clamped
 *   up to {@link KV_MIN_TTL_SECONDS}. `ttl <= 0` stores without expiry.
 * - Eventual consistency: writes are immediately visible in the writing
 *   location but can take up to ~60s to propagate to other edge locations —
 *   KV is a read-optimized store, not a coordination primitive (distributed
 *   locking stays SaaS-only).
 * - `delete()`'s returned boolean comes from a read-then-delete (KV's own
 *   delete is void); under concurrent writers it is best-effort, matching
 *   the advisory nature of the Backend contract.
 *
 * @example
 * ```typescript
 * import { createCache, workersKV } from '@cachekit-io/cachekit/workers';
 *
 * const cache = createCache.production({
 *   backend: workersKV({ kv: env.CACHE_KV }),
 *   ttl: 600,
 * });
 * ```
 */
export class WorkersKVBackend implements Backend {
  /** KV stores keys verbatim — no wire-key transform. See Backend.keyPrefix. */
  readonly keyPrefix?: string;
  private readonly kv: KVNamespaceLike;
  private readonly defaultTtl: number;
  private closed = false;

  constructor(config: WorkersKVBackendConfig) {
    if (!config.kv) {
      throw new ConfigurationError(
        'Workers KV backend requires a KVNamespace binding (config.kv, e.g. env.CACHE_KV)'
      );
    }
    this.kv = config.kv;
    this.defaultTtl = config.defaultTtl ?? DEFAULT_TTL_SECONDS;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();
    try {
      const buffer = await this.kv.get(key, 'arrayBuffer');
      return buffer === null ? null : new Uint8Array(buffer);
    } catch (error) {
      throw this.wrapError('get', error);
    }
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();
    const effectiveTtl = ttl ?? this.defaultTtl;
    try {
      await this.kv.put(
        key,
        value,
        effectiveTtl > 0
          ? { expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(effectiveTtl)) }
          : undefined
      );
    } catch (error) {
      throw this.wrapError('set', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    try {
      // KV's delete is void and idempotent; the contract's boolean needs a
      // read first. ponytail: racy under concurrent writers — the boolean is
      // advisory (drives cache.delete()'s return value, nothing durable).
      if ((await this.kv.get(key, 'arrayBuffer')) === null) {
        return false;
      }
      await this.kv.delete(key);
      return true;
    } catch (error) {
      throw this.wrapError('delete', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();
    try {
      // KV has no HEAD-style probe; this fetches the value. Cache payloads
      // are small (KB-scale), so the extra body transfer is acceptable.
      return (await this.kv.get(key, 'arrayBuffer')) !== null;
    } catch (error) {
      throw this.wrapError('exists', error);
    }
  }

  async close(): Promise<void> {
    // KV bindings have no connection to release.
    this.closed = true;
  }

  private wrapError(operation: string, error: unknown): BackendError {
    if (error instanceof Error) {
      return new BackendError(
        `Workers KV ${operation} failed: ${error.message}`,
        classifyWorkersRuntimeError(error),
        { cause: error }
      );
    }
    return new BackendError(`Workers KV ${operation} failed: Unknown error`);
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('Workers KV backend is closed');
    }
  }
}

/**
 * Create a Workers KV backend.
 *
 * @example
 * ```typescript
 * const cache = createCache({ backend: workersKV({ kv: env.CACHE_KV }) });
 * ```
 */
export function workersKV(config: WorkersKVBackendConfig): WorkersKVBackend {
  return new WorkersKVBackend(config);
}
