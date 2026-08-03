import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCache } from './cache.js';
import { generateKey } from './serialization/key-generator.js';
import { setLogger } from './logger.js';
import { ValueTooLargeError } from './errors.js';
import { MessagePackSerializer } from './serialization/serializer.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';

/**
 * Simple in-memory backend for testing cache integration.
 *
 * NOTE: All tests that don't explicitly set `compression: false` exercise ByteStorage
 * compression by default (CacheOptions.compression defaults to true). This is intentional —
 * it ensures the compression pipeline is continuously validated across all cache operations.
 */
class InMemoryBackend implements Backend {
  private store = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: Uint8Array, _ttl: number): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

describe('Cache Integration', () => {
  let cache: SecureCache;
  let backend: InMemoryBackend;

  beforeEach(() => {
    backend = new InMemoryBackend();
    cache = createCache({
      backend,
      defaultTtl: 3600,
      l1: { enabled: true, maxEntries: 100 },
    });
  });

  afterEach(async () => {
    await cache.close();
  });

  describe('Basic Operations', () => {
    it('should set and get values', async () => {
      await cache.set('test:key', { data: 'value' });
      const result = await cache.get<{ data: string }>('test:key');

      expect(result).toEqual({ data: 'value' });
    });

    it('should return null for missing keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should delete keys', async () => {
      await cache.set('test:delete', 'value');
      const deleted = await cache.delete('test:delete');
      const result = await cache.get('test:delete');

      expect(deleted).toBe(true);
      expect(result).toBeNull();
    });

    it('should check key existence', async () => {
      await cache.set('test:exists', 'value');

      expect(await cache.exists('test:exists')).toBe(true);
      expect(await cache.exists('test:nonexistent')).toBe(false);
    });
  });

  describe('Function Wrapping', () => {
    it('should cache function results', async () => {
      let callCount = 0;
      const expensiveFn = async (id: number) => {
        callCount++;
        return { id, data: `result-${id}` };
      };

      const cached = cache.wrap(expensiveFn, {
        namespace: 'test:fn',
        ttl: 3600,
      });

      // First call - should execute
      const result1 = await cached(123);
      expect(result1).toEqual({ id: 123, data: 'result-123' });
      expect(callCount).toBe(1);

      // Second call - should use cache
      const result2 = await cached(123);
      expect(result2).toEqual({ id: 123, data: 'result-123' });
      expect(callCount).toBe(1); // No additional call

      // Different args - should execute again
      const result3 = await cached(456);
      expect(result3).toEqual({ id: 456, data: 'result-456' });
      expect(callCount).toBe(2);
    });

    it('should support with() for partial application', async () => {
      const dbFetch = async (id: number) => ({ id, name: `user-${id}` });

      const cachedUser = cache.with({ namespace: 'users', ttl: 3600 });
      const getUser = cachedUser(dbFetch);

      const result = await getUser(789);
      expect(result).toEqual({ id: 789, name: 'user-789' });
    });
  });

  describe('L1 Cache Integration', () => {
    it('should populate L1 on get', async () => {
      await cache.set('test:l1', 'value');

      // First get populates L1
      await cache.get('test:l1');

      // Clear backend, verify L1 still has it
      await backend.delete('test:l1');
      const result = await cache.get('test:l1');

      expect(result).toBe('value'); // From L1
    });
  });

  describe('Invalidation', () => {
    it('should invalidate by key', async () => {
      await cache.set('test:invalidate', 'value');

      // First get populates L1
      await cache.get('test:invalidate');

      // Invalidate L1
      await cache.invalidate('params', { key: 'test:invalidate' });

      // Delete from backend too, then verify not in L1
      await backend.delete('test:invalidate');
      const result = await cache.get('test:invalidate');
      expect(result).toBeNull();
    });

    it('should invalidate by namespace', async () => {
      await cache.set('ns:key1', 'value1', { namespace: 'ns' });
      await cache.set('ns:key2', 'value2', { namespace: 'ns' });

      await cache.invalidate('namespace', { namespace: 'ns' });

      // L1 should be cleared for namespace entries
      // Note: Backend still has data, but L1 is invalidated
    });

    it('should invalidate all', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');

      await cache.invalidate('global');

      // L1 should be completely cleared
    });
  });

  describe('Encryption Integration', () => {
    it('should encrypt and decrypt values when encryption enabled', async () => {
      const encryptedCache = createCache({
        backend: new InMemoryBackend(),
        encryption: {
          masterKey: '0'.repeat(64), // 32 bytes hex
          tenantId: 'test-tenant',
        },
      });

      await encryptedCache.set('secure:key', { sensitive: 'data' });
      const result = await encryptedCache.get<{ sensitive: string }>('secure:key');

      expect(result).toEqual({ sensitive: 'data' });

      await encryptedCache.close();
    });
  });

  describe('Reliability Integration', () => {
    it('should apply retry on backend failures', async () => {
      let attempts = 0;
      const testBackend = new InMemoryBackend();

      const flakeyBackend: Backend = {
        async get(key: string) {
          attempts++;
          if (attempts < 2) {
            throw new Error('Transient failure');
          }
          return testBackend.get(key);
        },
        async set(key: string, value: Uint8Array, ttl: number) {
          return testBackend.set(key, value, ttl);
        },
        async delete(key: string) {
          return testBackend.delete(key);
        },
        async exists(key: string) {
          return testBackend.exists(key);
        },
        async close() {
          return testBackend.close();
        },
      };

      const retryCache = createCache({
        backend: flakeyBackend,
        reliability: {
          retry: { maxAttempts: 3, baseDelayMs: 10 },
        },
        l1: { enabled: false }, // Disable L1 to force backend access
      });

      await retryCache.set('test:retry', 'value');
      const result = await retryCache.get('test:retry');

      expect(result).toBe('value');
      expect(attempts).toBe(2); // First failed, second succeeded

      await retryCache.close();
    });
  });

  describe('Compression (ByteStorage)', () => {
    it('should round-trip with compression enabled (default)', async () => {
      const compressedCache = createCache({
        backend: new InMemoryBackend(),
        l1: { enabled: false },
      });

      const payload = { data: 'a'.repeat(1000) }; // Compressible
      await compressedCache.set('test:compressed', payload);
      const result = await compressedCache.get<typeof payload>('test:compressed');

      expect(result).toEqual(payload);
      await compressedCache.close();
    });

    it('should round-trip with compression disabled', async () => {
      const uncompressedCache = createCache({
        backend: new InMemoryBackend(),
        compression: false,
        l1: { enabled: false },
      });

      await uncompressedCache.set('test:uncompressed', { data: 'value' });
      const result = await uncompressedCache.get<{ data: string }>('test:uncompressed');

      expect(result).toEqual({ data: 'value' });
      await uncompressedCache.close();
    });

    it('should produce smaller output for compressible data', async () => {
      const compressedBackend = new InMemoryBackend();
      const uncompressedBackend = new InMemoryBackend();

      const compressedCache = createCache({
        backend: compressedBackend,
        compression: true,
        l1: { enabled: false },
      });
      const uncompressedCache = createCache({
        backend: uncompressedBackend,
        compression: false,
        l1: { enabled: false },
      });

      // Highly compressible: repeated data
      const payload = { data: 'hello world '.repeat(500) };
      await compressedCache.set('test:key', payload);
      await uncompressedCache.set('test:key', payload);

      const compressedBytes = await compressedBackend.get('test:key');
      const uncompressedBytes = await uncompressedBackend.get('test:key');

      expect(compressedBytes).not.toBeNull();
      expect(uncompressedBytes).not.toBeNull();
      expect(compressedBytes!.length).toBeLessThan(uncompressedBytes!.length);

      await compressedCache.close();
      await uncompressedCache.close();
    });

    it('should round-trip with compression + encryption', async () => {
      const cache = createCache({
        backend: new InMemoryBackend(),
        compression: true,
        encryption: {
          masterKey: '0'.repeat(64),
          tenantId: 'test-tenant',
        },
        l1: { enabled: false },
      });

      const payload = { sensitive: 'data', repeated: 'x'.repeat(500) };
      await cache.set('secure:key', payload);
      const result = await cache.get<typeof payload>('secure:key');

      expect(result).toEqual(payload);
      await cache.close();
    });

    it('should round-trip with encryption only (no compression)', async () => {
      const cache = createCache({
        backend: new InMemoryBackend(),
        compression: false,
        encryption: {
          masterKey: '0'.repeat(64),
          tenantId: 'test-tenant',
        },
        l1: { enabled: false },
      });

      await cache.set('secure:key', { data: 'value' });
      const result = await cache.get<{ data: string }>('secure:key');

      expect(result).toEqual({ data: 'value' });
      await cache.close();
    });
  });

  describe('Compression Error Handling', () => {
    it('should return null when backend returns corrupted compressed data (graceful degradation)', async () => {
      const corruptBackend = new InMemoryBackend();
      const cache = createCache({
        backend: corruptBackend,
        compression: true,
        l1: { enabled: false },
      });

      // Write valid data
      await cache.set('test:key', { data: 'value' });

      // Corrupt the stored bytes
      const stored = await corruptBackend.get('test:key');
      expect(stored).not.toBeNull();
      const corrupted = new Uint8Array(stored!);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
      await corruptBackend.set('test:key', corrupted, 3600);

      // ReliabilityExecutor catches the unpack error and degrades to null (cache miss)
      const result = await cache.get('test:key');
      expect(result).toBeNull();
      await cache.close();
    });

    // The pre-LAB-1388 version of this test closed the writer BEFORE the
    // read — InMemoryBackend.close() clears the shared store, so it
    // "verified" a degradation-to-null that never actually happened. The
    // envelope is itself valid MessagePack, so without envelope tolerance a
    // plain decode would have SUCCEEDED and served the raw 4-tuple envelope
    // as the cached value. Tolerance makes the mismatch read correct.
    it('reads enveloped entries correctly even with compression disabled (envelope tolerance)', async () => {
      const sharedBackend = new InMemoryBackend();

      // Write with compression enabled (0.1.5 default, or a mixed fleet)
      const writer = createCache({
        backend: sharedBackend,
        compression: true,
        l1: { enabled: false },
      });
      await writer.set('test:mismatch', { data: 'compressed' });

      // Read with compression disabled — the envelope is detected, verified
      // (xxHash3), and unwrapped; the caller gets the original value, never
      // the envelope structure.
      const reader = createCache({
        backend: sharedBackend,
        compression: false,
        l1: { enabled: false },
      });
      const result = await reader.get('test:mismatch');
      expect(result).toEqual({ data: 'compressed' });

      await writer.close();
      await reader.close();
    });

    it('degrades to null when an envelope-on cache reads raw-serialized bytes (reverse mismatch)', async () => {
      const sharedBackend = new InMemoryBackend();

      const rawWriter = createCache({
        backend: sharedBackend,
        compression: false,
        l1: { enabled: false },
      });
      await rawWriter.set('test:reverse', { data: 'raw' });

      // Envelope-on reader: unpack fails integrity, ReliabilityExecutor
      // degrades to a miss (pre-existing behavior, now actually pinned).
      const envelopeReader = createCache({
        backend: sharedBackend,
        compression: true,
        l1: { enabled: false },
      });
      expect(await envelopeReader.get('test:reverse')).toBeNull();

      await rawWriter.close();
      await envelopeReader.close();
    });
  });

  describe('Error Handling', () => {
    it('should throw when using closed cache', async () => {
      await cache.close();

      await expect(cache.get('test')).rejects.toThrow('Cache has been closed');
      await expect(cache.set('test', 'value')).rejects.toThrow('Cache has been closed');
      await expect(cache.delete('test')).rejects.toThrow('Cache has been closed');
    });
  });

  describe('SWR refresh persistence (L2-only setEntry + version-guarded L1)', () => {
    // The SWR refresh persists through setEntry with updateL1=false: the
    // ONLY L1 writer on the refresh path is completeRefresh, whose version
    // token discards the refresh when an explicit write landed meanwhile.
    // swrThresholdRatio: 2 makes every live L1 entry deterministically
    // stale (threshold ≥ 1.8×ttl > remaining TTL) — no clock control.

    /** Backend whose Nth set() call blocks on a gate (1-indexed). */
    class GatedBackend extends InMemoryBackend {
      setCount = 0;
      constructor(
        private readonly gatedCall: number,
        private readonly gate: Promise<void>
      ) {
        super();
      }
      override async set(key: string, value: Uint8Array, ttl: number): Promise<void> {
        this.setCount++;
        if (this.setCount === this.gatedCall) await this.gate;
        return super.set(key, value, ttl);
      }
    }

    it('completes a refresh via completeRefresh: L1 and L2 both end up with the new value', async () => {
      const swrBackend = new InMemoryBackend();
      const swrCache = createCache({
        backend: swrBackend,
        defaultTtl: 60,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });

      let calls = 0;
      const fn = swrCache.wrap(
        async () => {
          calls++;
          return { gen: calls };
        },
        { namespace: 'swr:persist', ttl: 60 }
      );

      expect(await fn()).toEqual({ gen: 1 }); // cold miss
      expect(await fn()).toEqual({ gen: 1 }); // stale hit, schedules refresh

      // completeRefresh is what lands gen 2 in L1 (plain get() does no SWR
      // read, so this observes L1 without scheduling more refreshes).
      const cacheKey = generateKey('swr:persist', []);
      await vi.waitFor(async () => {
        expect(await swrCache.get(cacheKey)).toEqual({ gen: 2 });
      });

      // And the refresh persisted to L2: a second cache on the same
      // backend with L1 disabled decodes the L2 bytes directly.
      const l2View = createCache({ backend: swrBackend, defaultTtl: 60, l1: { enabled: false } });
      expect(await l2View.get(cacheKey)).toEqual({ gen: 2 });
      await l2View.close();
      await swrCache.close();
    });

    it('an explicit set() during an in-flight refresh wins in L1 (refresh L1 write discarded)', async () => {
      // Gate the refresh's L2 persist (2nd backend set: 1st = cold miss,
      // 2nd = refresh, 3rd = the explicit set) so the explicit write can
      // interleave between the refresh's L2 write and its L1 completion.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gatedBackend = new GatedBackend(2, gate);
      const swrCache = createCache({
        backend: gatedBackend,
        defaultTtl: 60,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });

      let calls = 0;
      const fn = swrCache.wrap(
        async () => {
          calls++;
          return { gen: calls };
        },
        { namespace: 'swr:race', ttl: 60 }
      );
      const cacheKey = generateKey('swr:race', []);

      expect(await fn()).toEqual({ gen: 1 }); // cold miss (set #1)
      expect(await fn()).toEqual({ gen: 1 }); // stale hit → refresh blocks in set #2

      await vi.waitFor(() => {
        expect(gatedBackend.setCount).toBe(2); // refresh is parked in its L2 write
      });

      // Explicit write lands while the refresh is in flight — bumps the L1
      // version token. Pre-#84, setEntry's unconditional L1 write on the
      // refresh path would clobber this with the stale-computed value.
      await swrCache.set(cacheKey, { gen: 999 }, { ttl: 60, namespace: 'swr:race' });

      release();

      // The refresh finishes: its completeRefresh sees the bumped version
      // and discards — the explicit write stays authoritative in L1.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await swrCache.get(cacheKey)).toEqual({ gen: 999 });

      await swrCache.close();
    });
  });

  // ── LAB-1388 dogfooding fixes ─────────────────────────────────────────

  describe('L1 re-population TTL cap (LAB-1388)', () => {
    /** In-memory backend that tracks expiry and surfaces remaining TTL on
     * read — the getWithTtl capability (Cache API / Redis shape). */
    class TtlAwareBackend implements Backend {
      readonly store = new Map<string, { value: Uint8Array; expiresAt: number | null }>();

      private live(key: string) {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
          this.store.delete(key);
          return null;
        }
        return entry;
      }

      async get(key: string): Promise<Uint8Array | null> {
        return this.live(key)?.value ?? null;
      }

      async getWithTtl(key: string) {
        const entry = this.live(key);
        if (!entry) return null;
        const ttlSeconds =
          entry.expiresAt === null ? null : Math.max(0, (entry.expiresAt - Date.now()) / 1000);
        return { value: entry.value, ttlSeconds };
      }

      async set(key: string, value: Uint8Array, ttl: number): Promise<void> {
        this.store.set(key, { value, expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : null });
      }

      async delete(key: string): Promise<boolean> {
        return this.store.delete(key);
      }

      async exists(key: string): Promise<boolean> {
        return this.live(key) !== null;
      }

      async close(): Promise<void> {
        this.store.clear();
      }
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('caps a plain get() L1 re-population at the entry remaining lifetime', async () => {
      const shared = new TtlAwareBackend();
      const writer = createCache({ backend: shared, defaultTtl: 300 });
      // Second cache over the same backend = another isolate/process with
      // its own (empty) L1.
      const reader = createCache({ backend: shared, defaultTtl: 300 });

      await writer.set('ns:entry', 'v1', { ttl: 30 });

      // t=29s: the reader's plain get() is an L2 hit — pre-fix its L1 copy
      // got defaultTtl (300s) and served 'v1' long past the entry's expiry.
      vi.advanceTimersByTime(29_000);
      expect(await reader.get('ns:entry')).toBe('v1');

      // t=31s: entry expired in L2; the reader's L1 copy must be gone too.
      vi.advanceTimersByTime(2_000);
      expect(await reader.get('ns:entry')).toBeNull();

      await writer.close();
      await reader.close();
    });

    it('keeps serving from L1 within the remaining lifetime', async () => {
      const shared = new TtlAwareBackend();
      const writer = createCache({ backend: shared, defaultTtl: 300 });
      const reader = createCache({ backend: shared, defaultTtl: 300 });

      await writer.set('ns:entry', 'v1', { ttl: 30 });
      vi.advanceTimersByTime(10_000);
      expect(await reader.get('ns:entry')).toBe('v1'); // L2 hit, L1 capped at ~20s

      // Still fresh at t=25s — and served from the reader's L1 (delete the
      // L2 entry to prove the read never goes back to the backend).
      shared.store.clear();
      vi.advanceTimersByTime(15_000);
      expect(await reader.get('ns:entry')).toBe('v1');

      await writer.close();
      await reader.close();
    });

    it('falls back to defaultTtl on backends without getWithTtl (documented limitation)', async () => {
      const shared = new InMemoryBackend(); // no expiry tracking, no getWithTtl
      const writer = createCache({ backend: shared, defaultTtl: 300 });
      const reader = createCache({ backend: shared, defaultTtl: 300 });

      await writer.set('ns:entry', 'v1', { ttl: 30 });
      vi.advanceTimersByTime(29_000);
      expect(await reader.get('ns:entry')).toBe('v1');

      // The backend itself never expires entries and reports no TTL, so the
      // reader's L1 copy legitimately lives out defaultTtl — unchanged
      // pre-existing behavior for TTL-blind backends.
      vi.advanceTimersByTime(2_000);
      expect(await reader.get('ns:entry')).toBe('v1');

      await writer.close();
      await reader.close();
    });
  });

  describe('oversized-value set() warning (LAB-1388)', () => {
    afterEach(() => {
      setLogger(null);
      vi.useRealTimers();
    });

    // ~2 MiB of unique-ish content — over the 1 MiB default maxEncodedSize.
    const oversized = () => 'x'.repeat(2 * 1024 * 1024);

    it('reports a rate-limited warning even when degradation swallows the error', async () => {
      vi.useFakeTimers();
      const logs: string[] = [];
      setLogger((message) => logs.push(message));

      const c = createCache({ backend: new InMemoryBackend() });

      // Degradation is on by default: set() resolves silently…
      await expect(c.set('ns:big', oversized())).resolves.toBeUndefined();
      // …but the rejection is reported, once, greppably.
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(1);
      expect(logs[0]).toContain('maxEncodedSize');

      // Rate-limited: a hot oversized key cannot flood the sink.
      await c.set('ns:big', oversized());
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(1);

      // A fresh interval reports again.
      vi.advanceTimersByTime(61_000);
      await c.set('ns:big', oversized());
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(2);

      await c.close();
    });

    it('still throws ValueTooLargeError when degradation is disabled', async () => {
      const logs: string[] = [];
      setLogger((message) => logs.push(message));

      const c = createCache({
        backend: new InMemoryBackend(),
        reliability: { degradation: false },
      });

      await expect(c.set('ns:big', oversized())).rejects.toThrow(ValueTooLargeError);
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(1);

      await c.close();
    });

    it('warns on the interop encode path too (rejection throws to the caller but hides behind consumer try/catch)', async () => {
      const logs: string[] = [];
      setLogger((message) => logs.push(message));

      const c = createCache({ backend: new InMemoryBackend() });
      const big = c.wrap(async () => oversized(), {
        namespace: 'ns',
        ttl: 60,
        interop: 'bigop',
        interopArity: 0,
      });

      // Interop model/size rejection is a deterministic caller error —
      // degradation never swallows it — but it must still emit the
      // greppable warning for consumers whose own try/catch absorbs it.
      await expect(big()).rejects.toThrow(ValueTooLargeError);
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(1);

      await c.close();
    });
  });

  describe('backend-advertised compression default (LAB-1388)', () => {
    /** Plain MessagePack view of raw backend bytes ('decode failed' when the
     * envelope bytes aren't even valid MessagePack). */
    const plainDecode = (bytes: Uint8Array): unknown => {
      try {
        return new MessagePackSerializer().decode(bytes);
      } catch {
        return 'decode failed';
      }
    };

    class NoCompressionPreferenceBackend extends InMemoryBackend {
      readonly compressionDefault = false;
      readonly raw = new Map<string, Uint8Array>();

      override async set(key: string, value: Uint8Array, ttl: number): Promise<void> {
        this.raw.set(key, value);
        await super.set(key, value, ttl);
      }
    }

    it('honors compressionDefault=false: stored bytes are plain MessagePack', async () => {
      const b = new NoCompressionPreferenceBackend();
      const c = createCache({ backend: b, l1: { enabled: false } });

      await c.set('ns:k', { hello: 'world' });
      // No ByteStorage envelope: the raw backend bytes decode directly.
      const stored = [...b.raw.values()][0];
      expect(new MessagePackSerializer().decode(stored)).toEqual({ hello: 'world' });
      expect(await c.get('ns:k')).toEqual({ hello: 'world' });

      await c.close();
    });

    it('explicit compression: true overrides the backend preference', async () => {
      const b = new NoCompressionPreferenceBackend();
      const c = createCache({ backend: b, compression: true, l1: { enabled: false } });

      await c.set('ns:k', { hello: 'world' });
      // Enveloped: plain MessagePack decode of the raw bytes must not yield
      // the original value (the envelope wraps it).
      expect(plainDecode([...b.raw.values()][0])).not.toEqual({ hello: 'world' });
      expect(await c.get('ns:k')).toEqual({ hello: 'world' });

      await c.close();
    });

    it('backends without a preference keep the compressed default', async () => {
      const b = new NoCompressionPreferenceBackend();
      // Erase the preference to model a legacy/custom backend.
      Object.defineProperty(b, 'compressionDefault', { value: undefined });
      const c = createCache({ backend: b, l1: { enabled: false } });

      await c.set('ns:k', { hello: 'world' });
      expect(plainDecode([...b.raw.values()][0])).not.toEqual({ hello: 'world' });

      await c.close();
    });
  });
});
