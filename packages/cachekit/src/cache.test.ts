import { describe, it, expect, assert, beforeEach, afterEach, vi } from 'vitest';
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { ByteStorage } from '@cachekit-io/cachekit-core-ts';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCache } from './cache.js';
import { file } from './backends/file.js';
import { blake2b16Hex, generateKey } from './serialization/key-generator.js';
import { setLogger } from './logger.js';
import { createCache as createIntentCache } from './intents.js';
import {
  ConfigurationError,
  EncryptionError,
  SerializationError,
  ValueTooLargeError,
} from './errors.js';
import { forgedEnvelope } from '../test/fixtures/forged-envelope.js';
import { MessagePackSerializer } from './serialization/serializer.js';
import { EncryptionManagerCore } from './encryption/manager-core.js';
import type { SecureCache } from './types/cache.js';
import type { Backend } from './backends/types.js';
import { CacheImpl, type ByteStorageLike } from './cache-core.js';
import { L1Cache } from './l1/lru-cache.js';

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

    it('reports invalidate("namespace") with no namespace at the caller (LAB-4336)', async () => {
      // Nothing can carry this out, so it must not go on the wire: every peer
      // would discard it and log a mistake it cannot fix. The report belongs
      // in the process that made the call.
      const reported: string[] = [];
      setLogger((message) => reported.push(message));
      try {
        await cache.set('ns:key1', 'value1', { namespace: 'ns' });
        await cache.invalidate('namespace');
        expect(reported).toEqual([
          '[cachekit] invalidate("namespace") called with no namespace; nothing invalidated',
        ]);

        // A well-formed call stays quiet — the guard must not be broader.
        reported.length = 0;
        await cache.invalidate('namespace', { namespace: 'ns' });
        expect(reported).toEqual([]);
      } finally {
        setLogger(null);
      }
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
          retry: { maxAttempts: 3, baseDelay: 10 },
        },
        l1: { enabled: false }, // Disable L1 to force backend access
      });

      await retryCache.set('test:retry', 'value');
      const result = await retryCache.get('test:retry');

      expect(result).toBe('value');
      expect(attempts).toBe(2); // First failed, second succeeded

      await retryCache.close();
    });

    // LAB-239 regression: a backend's TTL rejection (Backend.validateTtl,
    // e.g. CachekitIO's protocol bounds) is a deterministic caller error and
    // must surface to the caller — default-on degradation swallows anything
    // thrown inside the executor, which would turn set(ttl: 0) into a cache
    // that silently never stores.
    it('surfaces a backend TTL rejection despite default-on degradation', async () => {
      let setCalls = 0;
      const inner = new InMemoryBackend();
      const boundedBackend: Backend = {
        get: (key) => inner.get(key),
        async set(key, value, ttl) {
          setCalls++;
          return inner.set(key, value, ttl!);
        },
        validateTtl(ttl) {
          if (ttl <= 0) throw new ConfigurationError(`TTL must be greater than 0, got ${ttl}`);
        },
        delete: (key) => inner.delete(key),
        exists: (key) => inner.exists(key),
        close: () => inner.close(),
      };

      const boundedCache = createCache({ backend: boundedBackend, l1: { enabled: false } });
      await expect(boundedCache.set('test:ttl0', 'value', { ttl: 0 })).rejects.toThrow(
        ConfigurationError
      );
      expect(setCalls).toBe(0); // rejected before the reliability executor ran

      await boundedCache.set('test:ttl-ok', 'value', { ttl: 60 });
      expect(setCalls).toBe(1);
      await boundedCache.close();
    });

    // LAB-2877 regression: a backend's key rejection (Backend.validateKey —
    // CachekitIO's reserved path segments) is the same kind of deterministic
    // caller error: inside the executor it would be retried, counted by the
    // circuit breaker, and swallowed by degradation into a silent miss or a
    // set() that never stores.
    it('surfaces a backend key rejection despite default-on degradation', async () => {
      const inner = new InMemoryBackend();
      const calls: string[] = [];
      const guardedBackend: Backend = {
        async get(key) {
          calls.push('get');
          return inner.get(key);
        },
        async set(key, value, ttl) {
          calls.push('set');
          return inner.set(key, value, ttl!);
        },
        async delete(key) {
          calls.push('delete');
          return inner.delete(key);
        },
        async exists(key) {
          calls.push('exists');
          return inner.exists(key);
        },
        close: () => inner.close(),
        validateKey(key) {
          if (key === '..') throw new ConfigurationError('reserved path segment');
        },
      };

      const guardedCache = createCache({
        backend: guardedBackend,
        compression: false,
        l1: { enabled: false },
      });
      await expect(guardedCache.get('..')).rejects.toThrow(ConfigurationError);
      await expect(guardedCache.set('..', 'value')).rejects.toThrow(ConfigurationError);
      await expect(guardedCache.delete('..')).rejects.toThrow(ConfigurationError);
      await expect(guardedCache.exists('..')).rejects.toThrow(ConfigurationError);
      expect(calls).toEqual([]); // rejected before the reliability executor ran

      await guardedCache.set('test:key-ok', 'value');
      expect(calls).toEqual(['set']);
      await guardedCache.close();
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
    /**
     * Drives the post-close in-flight read interleaving shared by the throwaway-codec
     * tests: start a get(), suspend it inside the backend, close() the cache, then
     * release it. Returns before the read settles so each caller asserts its own outcome.
     *
     * Only the key, the stored value, and the reader's compression mode vary. The gated
     * backend, the codec accounting, and the close/release ordering are deliberately a
     * single fixture — if those drifted between the two callers, one of them would stop
     * exercising the use-after-free window it exists to pin.
     */
    async function startPostCloseRead(opts: {
      key: string;
      value: { data: string };
      readerCompression: boolean;
    }) {
      const { key, value, readerCompression } = opts;
      const sharedBackend = new InMemoryBackend();

      // The writer always envelopes; the reader's compression mode is what varies.
      const writer = createCache({
        backend: sharedBackend,
        compression: true,
        l1: { enabled: false },
      });
      await writer.set(key, value);

      // Capture the enveloped bytes now — closing the caches clears the
      // shared in-memory store.
      const stored = await sharedBackend.get(key);
      expect(stored).not.toBeNull();

      // Backend whose get() blocks until released, so the read can be
      // suspended across close().
      let releaseGet!: () => void;
      const gateOpened = new Promise<void>((resolve) => (releaseGet = resolve));
      let getEntered!: () => void;
      const getStarted = new Promise<void>((resolve) => (getEntered = resolve));
      const gatedBackend = new Proxy(sharedBackend, {
        get(target, prop, receiver) {
          if (prop === 'get') {
            return async () => {
              getEntered();
              await gateOpened;
              return stored;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const reader = createCache({
        backend: gatedBackend,
        compression: readerCompression,
        l1: { enabled: false },
      });

      // Track every codec the reader creates for envelope tolerance and
      // every free() on them.
      const counts = { created: 0, freed: 0 };
      const impl = reader as unknown as { createByteStorage: () => ByteStorageLike };
      const realFactory = impl.createByteStorage;
      impl.createByteStorage = () => {
        counts.created++;
        const codec = realFactory();
        return {
          pack: (data) => codec.pack(data),
          unpack: (packed) => codec.unpack(packed),
          free: () => {
            counts.freed++;
            codec.free?.();
          },
        };
      };

      // Start the read (passes the closed guard), then close while it is
      // suspended inside the backend.
      const pending = reader.get(key);
      await getStarted;
      await reader.close();
      releaseGet();

      return { reader, pending, counts, writer };
    }

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

    it('frees a throwaway envelope codec when an in-flight read resumes after close()', async () => {
      const { reader, pending, counts, writer } = await startPostCloseRead({
        key: 'test:postclose',
        value: { data: 'compressed' },
        readerCompression: false,
      });

      // The read still completes correctly — via a throwaway codec that was
      // freed immediately, never cached on the closed instance.
      expect(await pending).toEqual({ data: 'compressed' });
      expect(counts.created).toBe(1);
      expect(counts.freed).toBe(1);
      expect((reader as unknown as { envelopeReader: unknown }).envelopeReader).toBeNull();

      await writer.close();
    });

    it('uses a freed-immediately throwaway codec for post-close reads on compression-ON caches too', async () => {
      // Same in-flight-across-close() interleaving as above, but on the
      // DEFAULT compression-on path: close() frees this.byteStorage, so the
      // resumed read must not unpack with the freed codec (a use-after-free
      // on the wasm binding) — it gets a throwaway instead (LAB-1768).
      const { pending, counts, writer } = await startPostCloseRead({
        key: 'test:postclose-on',
        value: { data: 'enveloped' },
        readerCompression: true,
      });

      expect(await pending).toEqual({ data: 'enveloped' });
      expect(counts.created).toBe(1);
      expect(counts.freed).toBe(1);

      await writer.close();
    });

    describe('read ceiling: maxDecodedSize bounds unpack, not just decode', () => {
      /** Codec spy: counts unpack calls; `unpackError` makes unpack throw it. */
      function spyCodec(unpackError?: unknown) {
        const calls = { unpack: 0 };
        const codec: ByteStorageLike = {
          pack: () => new Uint8Array(),
          unpack: () => {
            calls.unpack++;
            if (unpackError !== undefined) throw unpackError;
            return new Uint8Array();
          },
        };
        return { codec, calls };
      }

      async function readerOver(
        stored: Uint8Array,
        compression: boolean,
        codec?: ByteStorageLike, // omitted: the real core codec
        serializer?: { maxDecodedSize: number }
      ) {
        const backend = new InMemoryBackend();
        await backend.set('test:ceiling', stored, 3600);
        const reader = createCache({
          backend,
          compression,
          serializer,
          l1: { enabled: false },
          reliability: { degradation: false, retry: { maxAttempts: 1 } },
        });
        const impl = reader as unknown as {
          byteStorage: ByteStorageLike | null;
          createByteStorage: () => ByteStorageLike;
        };
        if (codec === undefined) return reader;
        if (compression) impl.byteStorage = codec;
        impl.createByteStorage = () => codec;
        return reader;
      }

      const declared = 16 * 1024 * 1024; // > 10 MiB default maxDecodedSize
      const bothPaths = [
        ['compression on', true],
        ['compression off (envelope tolerance)', false],
      ] as const;

      it.each(bothPaths)(
        'rejects an oversized envelope before unpack (%s)',
        async (_label, compression) => {
          const { codec, calls } = spyCodec();
          const reader = await readerOver(forgedEnvelope(declared), compression, codec);

          await expect(reader.get('test:ceiling')).rejects.toThrow(ValueTooLargeError);
          expect(calls.unpack).toBe(0);
          await reader.close();
        }
      );

      it.each(bothPaths)(
        'never unpacks a small declared size carrying an oversized payload (%s)',
        async (_label, compression) => {
          // Core would copy the whole payload before rejecting it.
          const { codec, calls } = spyCodec();
          const reader = await readerOver(forgedEnvelope(1, 64 * 1024), compression, codec);

          const read = reader.get<unknown[]>('test:ceiling');
          if (compression) await expect(read).rejects.toThrow(SerializationError);
          else expect((await read)?.length).toBe(4); // plain 4-tuple
          expect(calls.unpack).toBe(0);
          await reader.close();
        }
      );

      // Core's own pre-allocation checks, each named on a compression-on read
      // and each a plain-decode fallback under compression-off tolerance.
      const coreCapRejections = [
        ['over the 512 MiB size cap', forgedEnvelope(512 * 1024 * 1024 + 1, 1000), /size cap/],
        ['zero-length compressed_data', forgedEnvelope(0, 0), /zero-length compressed_data/],
        ['past the 1000:1 ratio', forgedEnvelope(1_000_001, 1000), /compression ratio cap/],
      ] as const;

      it.each(coreCapRejections)(
        'names an envelope %s on a compression-on read, never unpacking it',
        async (_label, stored, message) => {
          const { codec, calls } = spyCodec();
          const reader = await readerOver(stored, true, codec);

          const error = await reader.get('test:ceiling').catch((e: unknown) => e);
          expect(error).toBeInstanceOf(SerializationError);
          expect((error as Error).message).toMatch(message);
          // One message per check: no other check's text leaks in.
          for (const [, , other] of coreCapRejections) {
            if (other !== message) expect((error as Error).message).not.toMatch(other);
          }
          expect(calls.unpack).toBe(0);
          await reader.close();
        }
      );

      it.each(coreCapRejections)(
        'reads an envelope %s as a plain 4-tuple under compression-off tolerance',
        async (_label, stored) => {
          const { codec, calls } = spyCodec();
          const reader = await readerOver(stored, false, codec);

          expect((await reader.get<unknown[]>('test:ceiling'))?.length).toBe(4);
          expect(calls.unpack).toBe(0);
          await reader.close();
        }
      );

      it('lets maxDecodedSize raise the ceiling for envelopes that legitimately need it', async () => {
        const { codec, calls } = spyCodec();
        const reader = await readerOver(forgedEnvelope(declared), true, codec, {
          maxDecodedSize: declared,
        });

        // Passes the ceiling and reaches unpack; the spy's empty output then
        // fails to decode, which is not what this test is about.
        await expect(reader.get('test:ceiling')).rejects.toThrow();
        expect(calls.unpack).toBe(1);
        await reader.close();
      });

      it('still reads a plain value shaped like an envelope core would reject', async () => {
        // bytes, 8 small ints, a size over the ceiling, a string: an ordinary
        // value on a compression-off cache. Core refuses it on the 1000:1 cap
        // before allocating, so refusing it here would protect nothing.
        const value = [
          new Uint8Array([1, 2, 3]),
          [1, 2, 3, 4, 5, 6, 7, 8],
          12_000_000,
          'image/png',
        ];
        const backend = new InMemoryBackend();
        const cache = createCache({
          backend,
          compression: false,
          l1: { enabled: false },
          reliability: { degradation: false },
        });
        await cache.set('test:lookalike', value);

        expect(await cache.get('test:lookalike')).toEqual(value);
        await cache.close();
      });

      describe('encrypted caches: ciphertext length is bounded before decrypt', () => {
        const encryption = { masterKey: '0'.repeat(64), tenantId: 'ceiling' };

        it('stores exactly plaintext + 28 bytes (the pinned AEAD overhead)', async () => {
          // decodeEntry's pre-decrypt cap assumes nonce(12) + tag(16); if core
          // ever adds a header this fails here instead of refusing real reads.
          const backend = new InMemoryBackend();
          const cache = createCache({
            backend,
            encryption,
            compression: false,
            l1: { enabled: false },
          });
          const value = { data: 'x'.repeat(1000) };
          await cache.set('test:aead', value);
          const stored = await backend.get('test:aead');
          expect(stored!.length).toBe(new MessagePackSerializer().encode(value).length + 28);
          await cache.close();
        });

        it.each(bothPaths)(
          'refuses oversized junk ciphertext without decrypting it (%s)',
          async (_label, compression) => {
            const maxDecodedSize = 1000;
            const backend = new InMemoryBackend();
            // Longest plaintext this cache could decode + AEAD: an envelope within
            // the ceiling with compression on, a plain value with it off.
            const limit =
              (compression
                ? 2 * (20 + Math.floor((maxDecodedSize * 110) / 100)) + 256
                : maxDecodedSize) + 28;
            await backend.set('test:junk', new Uint8Array(limit + 1), 3600);
            const cache = createCache({
              backend,
              encryption,
              compression,
              serializer: { maxDecodedSize },
              l1: { enabled: false },
              reliability: { degradation: false, retry: { maxAttempts: 1 } },
            });
            const impl = cache as unknown as {
              encryption: { decrypt: (...args: unknown[]) => Promise<Uint8Array> };
            };
            let decrypts = 0;
            const realDecrypt = impl.encryption.decrypt.bind(impl.encryption);
            impl.encryption.decrypt = (...args) => {
              decrypts++;
              return realDecrypt(...args);
            };

            await expect(cache.get('test:junk')).rejects.toThrow(ValueTooLargeError);
            expect(decrypts).toBe(0);

            // At the limit it reaches decrypt (and fails authentication).
            await backend.set('test:junk', new Uint8Array(limit), 3600);
            await expect(cache.get('test:junk')).rejects.toThrow();
            expect(decrypts).toBe(1);
            await cache.close();
          }
        );
      });

      it.each([0, null, 42.5, { a: 1 }, 'x'.repeat(65)])(
        'reads back a look-alike whose fourth element no writer emits (%j)',
        async (fourth) => {
          // A real envelope's slot [3] is a short string. Core refuses the
          // non-strings before allocating, and none of these is ever unpacked,
          // so refusing to read them would protect nothing.
          const value = [new Uint8Array(12_000), [1, 2, 3, 4, 5, 6, 7, 8], 12_000_000, fourth];
          const cache = createCache({
            backend: new InMemoryBackend(),
            compression: false,
            l1: { enabled: false },
            reliability: { degradation: false },
          });
          await cache.set('test:lookalike', value);

          expect(await cache.get('test:lookalike')).toEqual(value);
          await cache.close();
        }
      );

      it('refuses (known loss) a plain value indistinguishable from an oversized envelope', async () => {
        // Within core's caps and over the ceiling: only decompressing could tell
        // this value from a real oversized envelope, and serving a real one as
        // its raw 4-tuple is silent corruption. So it is refused, and the key
        // misses; see SECURITY.md "Bounded decompression".
        const value = [new Uint8Array(12_000), [1, 2, 3, 4, 5, 6, 7, 8], 12_000_000, 'image/png'];
        const backend = new InMemoryBackend();
        const cache = createCache({
          backend,
          compression: false,
          l1: { enabled: false },
          reliability: { degradation: false },
        });
        await cache.set('test:lookalike', value);

        await expect(cache.get('test:lookalike')).rejects.toThrow(ValueTooLargeError);
        await cache.close();
      });

      it('propagates a wasm trap from the tolerance sniff instead of reading it as "not an envelope"', async () => {
        // Read off globalThis, as cache-core does: the lib set carries no WebAssembly types.
        const RuntimeError = (globalThis as { WebAssembly?: { RuntimeError?: ErrorConstructor } })
          .WebAssembly?.RuntimeError;
        assert(RuntimeError, 'runtime has no WebAssembly.RuntimeError');
        const trap = new RuntimeError('unreachable');
        const { codec, calls } = spyCodec(trap);
        const reader = await readerOver(forgedEnvelope(1000), false, codec);

        await expect(reader.get('test:ceiling')).rejects.toBe(trap);
        expect(calls.unpack).toBe(1);
        await reader.close();
      });

      it('propagates a JS allocation failure from the tolerance sniff', async () => {
        const oom = new RangeError('Array buffer allocation failed');
        const { codec } = spyCodec(oom);
        const reader = await readerOver(forgedEnvelope(1000), false, codec);

        await expect(reader.get('test:ceiling')).rejects.toBe(oom);
        await reader.close();
      });

      it('still treats an ordinary unpack rejection as a sniff miss, and reports it', async () => {
        // A core integrity/format rejection means "not an envelope": the bytes
        // are decoded as plain MessagePack (here, the 4-tuple itself). A
        // damaged real envelope reads the same way, so the rejection is
        // reported — rate-limited, key digested, core's error withheld.
        vi.useFakeTimers();
        const logs: { message: string; error: unknown }[] = [];
        setLogger((message, error) => logs.push({ message, error }));
        try {
          const stored = forgedEnvelope(1000);
          const { codec, calls } = spyCodec(new Error('Checksum mismatch'));
          const reader = await readerOver(stored, false, codec);
          const reports = () => logs.filter((l) => l.message.includes('failed verified unpack'));

          const value = await reader.get<unknown[]>('test:ceiling');
          expect(value?.length).toBe(4);
          expect(calls.unpack).toBe(1);
          expect(reports()).toHaveLength(1);
          const [report] = reports();
          expect(report.message).toContain(
            `keyHash=${blake2b16Hex('test:ceiling')}, bytes=${stored.length})`
          );
          expect(report.message).not.toContain('test:ceiling');
          // Post-decrypt, core's error text can echo plaintext: never logged.
          expect(report.message).not.toContain('Checksum mismatch');
          expect(report.error).toBeUndefined();

          await reader.get('test:ceiling');
          expect(reports()).toHaveLength(1);
          vi.advanceTimersByTime(61_000);
          await reader.get('test:ceiling');
          expect(reports()).toHaveLength(2);
          await reader.close();
        } finally {
          setLogger(null);
          vi.useRealTimers();
        }
      });

      it('never unpacks bytes that only pass the one-byte sniff', async () => {
        // A plain user value that passes looksLikeEnvelope's fixarray(4) sniff
        // with a bin [0], but whose [1] is not a checksum: the header read
        // rules it out.
        const plain = new MessagePackSerializer().encode([new Uint8Array([1]), 'x', 3, 'y']);
        const { codec, calls } = spyCodec();
        const reader = await readerOver(plain, false, codec);

        expect(await reader.get('test:ceiling')).toEqual([new Uint8Array([1]), 'x', 3, 'y']);
        expect(calls.unpack).toBe(0);
        await reader.close();
      });

      it('rejects an oversized plain 4-tuple as too large, never unpacking it', async () => {
        // Every fixarray(4) value reaches envelopeVerdict now; one longer than
        // any envelope within the ceiling fails there, with the same error a
        // plain decode over maxDecodedSize would give.
        const plain = new MessagePackSerializer().encode(['x'.repeat(3000), 1, 2, 3]);
        const { codec, calls } = spyCodec();
        const reader = await readerOver(plain, false, codec, { maxDecodedSize: 1000 });

        await expect(reader.get('test:ceiling')).rejects.toThrow(ValueTooLargeError);
        expect(calls.unpack).toBe(0);
        await reader.close();
      });

      describe('legacy (array-of-ints) envelopes, as published 0.1.5 writes them', () => {
        it('reads a fixarray-encoded legacy envelope back as its value', async () => {
          // The exact bytes published @cachekit-io/cachekit-core-wasm 0.1.1
          // packs for { data: 'legacy' }: compressed_data is fixarray(14).
          const stored = Buffer.from(
            '949eccd0cc81cca464617461cca66c65676163799847cca5ccbf281e65ccbaccad0da76d73677061636b', // pragma: allowlist secret
            'hex'
          );
          expect(stored[1]).toBe(0x9e);
          const reader = await readerOver(new Uint8Array(stored), false);

          expect(await reader.get('test:ceiling')).toEqual({ data: 'legacy' });
          await reader.close();
        });

        it('reads an array16-encoded legacy envelope back as its value', async () => {
          const value = { data: 'a legacy envelope with more than fifteen compressed bytes' };
          // Today's bin-form envelope, re-encoded with compressed_data as ints.
          const binForm = new ByteStorage().pack(new MessagePackSerializer().encode(value));
          const [data, checksum, size, format] = msgpackDecode(binForm) as [
            Uint8Array,
            number[],
            number,
            string,
          ];
          const stored = msgpackEncode([Array.from(data), checksum, size, format]);
          expect([stored[0], stored[1]]).toEqual([0x94, 0xdc]);
          const reader = await readerOver(stored, false);

          expect(await reader.get('test:ceiling')).toEqual(value);
          await reader.close();
        });

        it('still reads a plain legacy-shaped 4-tuple that core rejects as itself', async () => {
          // Passes the header read and envelopeVerdict, so it reaches the real
          // unpack — which rejects [1, 2, 3] as an LZ4 block for 3 bytes.
          const logs: string[] = [];
          setLogger((message) => logs.push(message));
          try {
            const value = [[1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8], 3, 'msgpack'];
            const reader = await readerOver(new MessagePackSerializer().encode(value), false);

            expect(await reader.get('test:ceiling')).toEqual(value);
            expect(logs.filter((m) => m.includes('failed verified unpack'))).toHaveLength(1);
            await reader.close();
          } finally {
            setLogger(null);
          }
        });

        it('never unpacks a legacy-shaped 4-tuple whose [1] is not a checksum', async () => {
          const value = [[1, 2, 3], 'x', 3, 'y'];
          const { codec, calls } = spyCodec();
          const reader = await readerOver(new MessagePackSerializer().encode(value), false, codec);

          expect(await reader.get('test:ceiling')).toEqual(value);
          expect(calls.unpack).toBe(0);
          await reader.close();
        });

        it('refuses (known loss) a plain value indistinguishable from an oversized legacy envelope', async () => {
          // Legacy twin of the bin-form known loss above: under the 1000:1 cap
          // and over a lowered ceiling, so only decompressing could tell it apart.
          const value = [
            Array.from({ length: 9_000 }, (_, i) => i % 256),
            [1, 2, 3, 4, 5, 6, 7, 8],
            9_000_000,
            'x',
          ];
          const reader = await readerOver(
            new MessagePackSerializer().encode(value),
            false,
            undefined,
            {
              maxDecodedSize: 1024 * 1024,
            }
          );

          await expect(reader.get('test:ceiling')).rejects.toThrow(ValueTooLargeError);
          await reader.close();
        });
      });
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

  describe('L1 size hint (serialized length, never the envelope)', () => {
    // Compressible, so the stored envelope is much smaller than the msgpack
    // it carries: a hint taken from the stored bytes would show up here.
    const value = { text: 'compressible '.repeat(500), n: 7 };
    const serializedLength = new MessagePackSerializer().encode(value).length;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('a plaintext set() hands L1 the serialized length', async () => {
      const spy = vi.spyOn(L1Cache.prototype, 'set');
      await cache.set('hint:write', value);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][4]).toBe(serializedLength);
    });

    it('a plaintext L2-hit get() hands L1 the decoded msgpack length, not the stored bytes', async () => {
      await cache.set('hint:read', value);
      const stored = await backend.get('hint:read');
      expect(stored!.byteLength).toBeLessThan(serializedLength / 4);

      // A second cache on the same backend: its L1 is empty, so the read is an L2 hit.
      const reader = createCache({ backend, defaultTtl: 3600, l1: { enabled: true } });
      const spy = vi.spyOn(L1Cache.prototype, 'set');
      expect(await reader.get('hint:read')).toEqual(value);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][4]).toBe(serializedLength);
      await reader.close();
    });

    it('an SWR refresh hands completeRefresh the serialized length', async () => {
      const swrCache = createCache({
        backend: new InMemoryBackend(),
        defaultTtl: 60,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });
      const spy = vi.spyOn(L1Cache.prototype, 'completeRefresh');
      const fn = swrCache.wrap(async () => value, { namespace: 'hint:swr', ttl: 60 });
      await fn(); // cold miss
      await fn(); // stale hit, schedules the refresh
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      expect(spy.mock.calls[0][5]).toBe(serializedLength);
      await swrCache.close();
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

    it('a refresh whose value fails to encode leaves L1 alone on a plaintext cache', async () => {
      // A direct write and a cold miss store nothing for a value the encoder
      // rejects; the refresh must not be the one path that puts it in L1.
      const logs: string[] = [];
      setLogger((message) => logs.push(message));
      const completeRefresh = vi.spyOn(L1Cache.prototype, 'completeRefresh');
      const swrCache = createCache({
        backend: new InMemoryBackend(),
        defaultTtl: 60,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
        serializer: { maxCollectionSize: 10 },
      });
      try {
        let calls = 0;
        const fn = swrCache.wrap(
          async () => (++calls === 1 ? [1] : Array.from({ length: 11 }, (_, i) => i)),
          { namespace: 'swr:unencodable', ttl: 60 }
        );

        expect(await fn()).toEqual([1]); // cold miss
        expect(await fn()).toEqual([1]); // stale hit, refresh computes 11 items
        await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0)); // the rejection warning
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(calls).toBe(2);
        expect(completeRefresh).not.toHaveBeenCalled();
        expect(await swrCache.get(generateKey('swr:unencodable', []))).toEqual([1]);
      } finally {
        setLogger(null);
        completeRefresh.mockRestore();
        await swrCache.close();
      }
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

    it('repopulates L1 forever when defaultTtl is 0 and the entry has no expiry (LAB-1388)', async () => {
      const shared = new TtlAwareBackend();
      const writer = createCache({ backend: shared, defaultTtl: 0 });
      const reader = createCache({ backend: shared, defaultTtl: 0 });

      await writer.set('ns:entry', 'v1'); // ttl<=0 -> no expiry, per Backend contract

      // Pre-fix, capSeconds (0) collapsed the Math.min cap to 0 and the
      // `l1TtlSeconds > 0` guard skipped L1 repopulation entirely.
      expect(await reader.get('ns:entry')).toBe('v1'); // L2 hit, should populate L1

      shared.store.clear(); // prove the next read comes from L1, not L2
      expect(await reader.get('ns:entry')).toBe('v1');

      await writer.close();
      await reader.close();
    });

    it('keeps a no-expiry L1 re-population SWR-fresh (no phantom refresh loop, LAB-1768)', async () => {
      const shared = new TtlAwareBackend();
      const writer = createCache({ backend: shared, defaultTtl: 0 });
      const reader = createCache({
        backend: shared,
        defaultTtl: 0,
        l1: { swrEnabled: true, swrThresholdRatio: 2 },
      });

      let computes = 0;
      const compute = async () => {
        computes++;
        return 'v1';
      };

      // Seed L2 (no expiry) through the writer so the reader's first wrap()
      // read is an L2 hit that re-populates its L1 through the getWithTtl
      // path with ttlSeconds: null.
      const seed = writer.wrap(compute, { namespace: 'noexp', ttl: 0 });
      expect(await seed()).toBe('v1');
      expect(computes).toBe(1);

      const read = reader.wrap(compute, { namespace: 'noexp', ttl: 0 });
      expect(await read()).toBe('v1'); // L2 hit → L1 re-populate
      expect(computes).toBe(1);

      // Pre-fix, the L1 copy carried originalTtl = Infinity, so getWithSwr's
      // freshness check compared Infinity > Infinity — permanently stale —
      // and every read here armed a background refresh that re-ran compute
      // and rewrote L2, forever, on exactly the entries configured to never
      // expire.
      expect(await read()).toBe('v1');
      expect(await read()).toBe('v1');
      await Promise.resolve(); // let any (wrongly) scheduled refresh start
      expect(computes).toBe(1);

      await writer.close();
      await reader.close();
    });
  });

  // ~2 MiB of unique-ish content — over the 1 MiB default maxEncodedSize.
  const oversized = () => 'x'.repeat(2 * 1024 * 1024);

  describe('oversized-value set() warning (LAB-1388)', () => {
    afterEach(() => {
      setLogger(null);
      vi.useRealTimers();
    });

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
      // Keys are caller-controlled and may embed PII — the line carries a
      // non-reversible digest, never the raw key.
      expect(logs[0]).toContain('keyHash=');
      expect(logs[0]).not.toContain('ns:big');

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
        namespace: 'blobs',
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

  describe('rejected-value set() warning beyond size (LAB-4845)', () => {
    afterEach(() => {
      setLogger(null);
      vi.useRealTimers();
    });

    const nested = (depth: number): unknown => (depth === 0 ? 'leaf' : [nested(depth - 1)]);

    it.each([
      ['a non-Uint8Array binary value', () => new Float32Array([1.5])],
      ['a depth-exceeded value', () => nested(200)],
      // Not a SerializationError: @msgpack/msgpack throws a plain Error.
      ['a value msgpack cannot encode', () => ({ fn: () => 1 })],
    ])('warns when degradation absorbs %s', async (_label, value) => {
      const logs: string[] = [];
      setLogger((message) => logs.push(message));

      const backend = new InMemoryBackend();
      const c = createCache({ backend });

      // Degradation is on by default: set() resolves and nothing is stored…
      await expect(c.set('ns:bad', value())).resolves.toBeUndefined();
      expect(await c.get('ns:bad')).toBeNull();
      // …but the rejection is reported, digested, without the size hint.
      const rejected = logs.filter((m) => m.includes('set rejected'));
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toContain('keyHash=');
      expect(rejected[0]).not.toContain('ns:bad');
      expect(rejected[0]).not.toContain('maxEncodedSize');

      await c.close();
    });

    // A getter or Proxy trap runs caller code inside normalize, so its error
    // text is caller-controlled and may carry the value or the key verbatim.
    it.each([
      ['an Error', (key: string) => new Error(`private=VALUE_SENTINEL key=${key}`)],
      ['a non-Error', (key: string) => `private=VALUE_SENTINEL key=${key}`],
      // The class is not provenance: callers can throw the SDK's own errors.
      [
        'a SerializationError',
        (key: string) => new SerializationError(`private=VALUE_SENTINEL key=${key}`),
      ],
      [
        'a ValueTooLargeError',
        (key: string) => new ValueTooLargeError(`private=VALUE_SENTINEL key=${key}`),
      ],
    ])('never logs the message when a getter throws %s', async (_label, thrown) => {
      const logs: string[] = [];
      setLogger((message) => logs.push(message));

      const key = 'ns:raw-KEY_SENTINEL';
      const value = {
        get payload(): never {
          throw thrown(key);
        },
      };
      const c = createCache({ backend: new InMemoryBackend() });

      await expect(c.set(key, value)).resolves.toBeUndefined();
      const rejected = logs.filter((m) => m.includes('set rejected'));
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toContain('keyHash=');
      expect(rejected[0]).not.toContain('VALUE_SENTINEL');
      expect(rejected[0]).not.toContain('KEY_SENTINEL');

      await c.close();
    });

    it('warns through wrap(), rate-limited per cache', async () => {
      vi.useFakeTimers();
      const logs: string[] = [];
      setLogger((message) => logs.push(message));

      const c = createCache({ backend: new InMemoryBackend() });
      let calls = 0;
      const embed = c.wrap(
        async () => {
          calls++;
          return new Float32Array([1.5]);
        },
        { namespace: 'ns', ttl: 60 }
      );

      await embed();
      await embed();
      expect(calls).toBe(2); // never cached
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(1);

      vi.advanceTimersByTime(61_000);
      await embed();
      expect(logs.filter((m) => m.includes('set rejected'))).toHaveLength(2);

      await c.close();
    });
  });

  describe('encode rejections bypass retry and the circuit breaker (LAB-5139)', () => {
    afterEach(() => {
      setLogger(null);
      vi.restoreAllMocks();
    });

    // production preset: retry 3x with backoff, breaker opens at 5 failures.
    const productionCache = (backend: Backend, serializer?: { maxCollectionSize: number }) =>
      createIntentCache.production({ backend, metrics: false, serializer });

    it('six oversized set() calls leave the breaker closed for other keys', async () => {
      setLogger(() => {});
      const backend = new InMemoryBackend();
      const c = productionCache(backend);

      for (let i = 0; i < 6; i++) {
        await expect(c.set(`ns:big${i}`, oversized())).resolves.toBeUndefined();
      }

      // An open breaker would degrade this write to a no-op (L1 included),
      // so the read-back proves the breaker never counted the rejections.
      await c.set('ns:small', 'ok');
      expect(await c.get('ns:small')).toBe('ok');
      expect(await backend.get('ns:small')).not.toBeNull();

      await c.close();
    });

    it('an oversized set() encodes once and never reaches backend.set', async () => {
      setLogger(() => {});
      const backend = new InMemoryBackend();
      const backendSet = vi.spyOn(backend, 'set');
      const c = productionCache(backend);
      // Each encode reads the property once, so the read count is the encode count.
      let reads = 0;
      const value = {
        get big() {
          reads++;
          return oversized();
        },
      };

      await expect(c.set('ns:big', value)).resolves.toBeUndefined();
      expect(reads).toBe(1);
      expect(backendSet).not.toHaveBeenCalled();

      await c.close();
    });

    it('a SerializationError encodes once and never counts toward the breaker', async () => {
      const backend = new InMemoryBackend();
      const c = productionCache(backend, { maxCollectionSize: 10 });
      const tooMany = Array.from({ length: 11 }, (_, i) => i);
      // Each encode reads the property once, so the read count is the encode count.
      let reads = 0;
      const wide = {
        get items() {
          reads++;
          return tooMany;
        },
      };

      await expect(c.set('ns:wide0', wide)).resolves.toBeUndefined();
      expect(reads).toBe(1);

      for (let i = 1; i < 6; i++) await c.set(`ns:wide${i}`, tooMany);
      await c.set('ns:small', 'ok');
      expect(await c.get('ns:small')).toBe('ok');

      await c.close();
    });
  });

  describe('L2 decode failures bypass retry and the circuit breaker (LAB-7079)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const KEY_A = 'a'.repeat(64);
    const KEY_B = 'b'.repeat(64);
    // production reliability: retry 3x with backoff, breaker opens at 5 failures.
    // l1 off so every read reaches L2.
    const secureCache = (backend: Backend, masterKey: string, degradation = true) =>
      createIntentCache.secure({
        backend,
        masterKey,
        tenantId: 'lab-7079',
        l1: { enabled: false },
        metrics: false,
        reliability: { degradation },
      });
    const productionCache = (backend: Backend, degradation = true) =>
      createIntentCache.production({
        backend,
        l1: { enabled: false },
        metrics: false,
        reliability: { degradation },
      });

    /**
     * Seed `count` entries under KEY_A, so a KEY_B cache cannot decrypt them
     * (rotation). The writer is left open: close() would close the shared
     * backend, and InMemoryBackend.close() clears the store.
     */
    async function seedRotated(backend: Backend, count: number): Promise<void> {
      const writer = secureCache(backend, KEY_A);
      for (let i = 0; i < count; i++) await writer.set(`ns:old${i}`, `v${i}`);
    }

    it('a read after key rotation fetches once and returns null', async () => {
      const backend = new InMemoryBackend();
      await seedRotated(backend, 1);
      const backendGet = vi.spyOn(backend, 'get');
      const recordFailure = vi.spyOn(
        CacheImpl.prototype as unknown as { recordFailure: (op: string, e: unknown) => void },
        'recordFailure'
      );
      const c = secureCache(backend, KEY_B);

      expect(await c.get('ns:old0')).toBeNull();
      expect(backendGet).toHaveBeenCalledTimes(1);
      // The error metric still records the failure, once.
      expect(recordFailure).toHaveBeenCalledTimes(1);
      expect(recordFailure.mock.calls[0]?.[0]).toBe('l2_decode');

      await c.close();
    });

    it('ten undecryptable reads leave the breaker closed for a healthy key', async () => {
      const backend = new InMemoryBackend();
      await seedRotated(backend, 10);
      const c = secureCache(backend, KEY_B);
      await c.set('ns:fresh', 'ok');
      const backendGet = vi.spyOn(backend, 'get');

      for (let i = 0; i < 10; i++) expect(await c.get(`ns:old${i}`)).toBeNull();
      expect(backendGet).toHaveBeenCalledTimes(10);

      // An open breaker would degrade this read to null with 0 GETs.
      backendGet.mockClear();
      expect(await c.get('ns:fresh')).toBe('ok');
      expect(backendGet).toHaveBeenCalledTimes(1);

      await c.close();
    });

    it('foreign bytes on a compression-on cache fetch once per read, breaker closed', async () => {
      const backend = new InMemoryBackend();
      const c = productionCache(backend);
      await c.set('ns:fresh', 'ok');
      for (let i = 0; i < 10; i++)
        await backend.set(`ns:bad${i}`, new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 60);
      const backendGet = vi.spyOn(backend, 'get');

      for (let i = 0; i < 10; i++) expect(await c.get(`ns:bad${i}`)).toBeNull();
      expect(backendGet).toHaveBeenCalledTimes(10);

      backendGet.mockClear();
      expect(await c.get('ns:fresh')).toBe('ok');
      expect(backendGet).toHaveBeenCalledTimes(1);

      await c.close();
    });

    it('with degradation off a decode failure still throws, after one fetch', async () => {
      const backend = new InMemoryBackend();
      await seedRotated(backend, 1);
      await backend.set('ns:bad', new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 60);
      const backendGet = vi.spyOn(backend, 'get');
      const secure = secureCache(backend, KEY_B, false);
      const plain = productionCache(backend, false);

      await expect(secure.get('ns:old0')).rejects.toThrow(EncryptionError);
      await expect(plain.get('ns:bad')).rejects.toThrow(SerializationError);
      expect(backendGet).toHaveBeenCalledTimes(2);

      await secure.close();
      await plain.close();
    });

    it('a transient decrypt failure (e.g. first-use binding load) is not retried', async () => {
      // Pinned on purpose: decrypt runs after the executor, so even a
      // transient failure inside it is a single miss, not a retried read.
      const backend = new InMemoryBackend();
      const c = secureCache(backend, KEY_A);
      await c.set('ns:k', 'v');
      const backendGet = vi.spyOn(backend, 'get');
      vi.spyOn(EncryptionManagerCore.prototype, 'decrypt').mockRejectedValueOnce(
        new Error('native binding failed to load')
      );

      expect(await c.get('ns:k')).toBeNull();
      expect(backendGet).toHaveBeenCalledTimes(1);

      await c.close();
    });
  });

  describe('secure keys over the AAD limit are rejected before the reliability executor (LAB-5142)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const TENANT = 'lab-5142';
    const MAX_AAD = 64 * 1024;
    // v0x03 AAD = version byte + four 4-byte length prefixes + tenant id + key
    // + 'msgpack' + 'True'/'False' (the compressed flag). Written out rather
    // than derived from buildAAD so the boundary is pinned to the protocol
    // layout, not to the implementation.
    const keyBudget = (compressed: boolean) =>
      MAX_AAD - (1 + 16 + TENANT.length + 'msgpack'.length + (compressed ? 4 : 5));
    /** A key of exactly `bytes` UTF-8 bytes; `multibyte` spends most of it on 2-byte 'é'. */
    const keyOfBytes = (bytes: number, multibyte = false) => {
      const body = bytes - 'ns:'.length;
      const wide = multibyte ? Math.floor(body / 2) : 0;
      return `ns:${'é'.repeat(wide)}${'k'.repeat(body - 2 * wide)}`;
    };
    // production reliability: retry 3x with backoff, breaker opens at 5 failures.
    const secureCache = (backend: Backend, compression?: boolean) =>
      createIntentCache.secure({
        backend,
        masterKey: '0'.repeat(64),
        tenantId: TENANT,
        compression,
        metrics: false,
      });
    // InMemoryBackend advertises no compression default, so the envelope is on.
    const overLimitKey = keyOfBytes(keyBudget(true) + 1);

    it('six over-limit set() calls reject and leave the breaker closed', async () => {
      const backend = new InMemoryBackend();
      const c = secureCache(backend);

      for (let i = 0; i < 6; i++) {
        await expect(c.set(`${overLimitKey}${i}`, 'v')).rejects.toThrow(ConfigurationError);
      }

      // An open breaker would degrade this write to a no-op, so the
      // read-back proves the rejections were never counted.
      await c.set('ns:small', 'ok');
      expect(await c.get('ns:small')).toBe('ok');
      expect(await backend.get('ns:small')).not.toBeNull();

      await c.close();
    });

    it('never calls encrypt for an over-limit key', async () => {
      const encrypt = vi.spyOn(EncryptionManagerCore.prototype, 'encrypt');
      const c = secureCache(new InMemoryBackend());

      await expect(c.set(overLimitKey, 'v')).rejects.toThrow(ConfigurationError);
      expect(encrypt).not.toHaveBeenCalled();

      await c.close();
    });

    it('get() rejects before any backend or decrypt call', async () => {
      const backend = new InMemoryBackend();
      // Seeded, so a read that skipped the pre-flight would reach decrypt.
      await backend.set(overLimitKey, new Uint8Array([1]), 60);
      const backendGet = vi.spyOn(backend, 'get');
      const decrypt = vi.spyOn(EncryptionManagerCore.prototype, 'decrypt');
      const c = secureCache(backend);

      await expect(c.get(overLimitKey)).rejects.toThrow(ConfigurationError);
      expect(backendGet).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();

      await c.close();
    });

    it('wrap() whose namespace pushes the key 1 byte over the budget rejects before computing', async () => {
      const c = secureCache(new InMemoryBackend());
      const compute = vi.fn(async () => 'v');
      // generateKey appends ':' + 64 hex digits, pushing this key 1 byte over.
      const wrapped = c.wrap(compute, { namespace: keyOfBytes(keyBudget(true) - 64), ttl: 60 });

      await expect(wrapped()).rejects.toThrow(ConfigurationError);
      expect(compute).not.toHaveBeenCalled();

      await c.close();
    });

    // The at-limit key round-trips through the real native encrypt/decrypt, so
    // this also proves the TS limit matches the binding's, byte for byte.
    it.each([
      { compression: true, multibyte: false },
      { compression: false, multibyte: true },
    ])(
      'boundary is 65 536 AAD bytes, counted in UTF-8 (compression=$compression, multibyte=$multibyte)',
      async ({ compression, multibyte }) => {
        const c = secureCache(new InMemoryBackend(), compression);
        const atLimit = keyOfBytes(keyBudget(compression), multibyte);

        await c.set(atLimit, 'fits');
        expect(await c.get(atLimit)).toBe('fits');
        await expect(c.set(`${atLimit}k`, 'v')).rejects.toThrow(ConfigurationError);
        await expect(c.get(`${atLimit}k`)).rejects.toThrow(ConfigurationError);

        await c.close();
      }
    );

    it('a cache without encryption stores the same key as before', async () => {
      const backend = new InMemoryBackend();
      const c = createIntentCache.production({ backend, metrics: false });

      await c.set(overLimitKey, 'plain');
      expect(await c.get(overLimitKey)).toBe('plain');
      expect(await backend.get(overLimitKey)).not.toBeNull();

      await c.close();
    });
  });

  describe('the encryption AAD binds the key passed to the backend, keyPrefix included', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Applies its keyPrefix to every key over a shared store, as the Redis
     * and Memcached backends do on the wire. */
    class PrefixingBackend implements Backend {
      constructor(
        readonly keyPrefix: string | undefined,
        readonly store: Map<string, Uint8Array>
      ) {}
      private wire(key: string): string {
        return (this.keyPrefix ?? '') + key;
      }
      async get(key: string): Promise<Uint8Array | null> {
        return this.store.get(this.wire(key)) ?? null;
      }
      async set(key: string, value: Uint8Array): Promise<void> {
        this.store.set(this.wire(key), value);
      }
      async delete(key: string): Promise<boolean> {
        return this.store.delete(this.wire(key));
      }
      async exists(key: string): Promise<boolean> {
        return this.store.has(this.wire(key));
      }
      async close(): Promise<void> {}
    }

    // One master key and tenant for every cache; degradation off so a decrypt
    // failure throws instead of reading as a miss.
    const secureOver = (backend: Backend) =>
      createCache({
        backend,
        l1: { enabled: false },
        encryption: { masterKey: '0'.repeat(64), tenantId: 'one-tenant' },
        reliability: { degradation: false, retry: { maxAttempts: 1 } },
      });

    it('ciphertext copied to another prefix fails authentication', async () => {
      const store = new Map<string, Uint8Array>();
      const app1 = secureOver(new PrefixingBackend('app1:', store));
      const app2 = secureOver(new PrefixingBackend('app2:', store));

      await app1.set('k1', { v: 'from-app1' });
      store.set('app2:k1', store.get('app1:k1')!);

      await expect(app2.get('k1')).rejects.toThrow(EncryptionError);
      expect(await app1.get('k1')).toEqual({ v: 'from-app1' });

      await app1.close();
      await app2.close();
    });

    it.each([
      { keyPrefix: 'app1:', bound: 'app1:k1' },
      { keyPrefix: '', bound: 'k1' },
      { keyPrefix: undefined, bound: 'k1' },
    ])(
      'keyPrefix $keyPrefix binds $bound at encrypt, decrypt and the AAD-size pre-flight',
      async ({ keyPrefix, bound }) => {
        const encrypt = vi.spyOn(EncryptionManagerCore.prototype, 'encrypt');
        const decrypt = vi.spyOn(EncryptionManagerCore.prototype, 'decrypt');
        const validateKey = vi.spyOn(EncryptionManagerCore.prototype, 'validateKey');
        const c = secureOver(new PrefixingBackend(keyPrefix, new Map()));

        await c.set('k1', 'v');
        expect(await c.get('k1')).toBe('v');

        expect(encrypt).toHaveBeenCalledWith(expect.anything(), bound, true);
        expect(decrypt).toHaveBeenCalledWith(expect.anything(), bound, true);
        expect(validateKey.mock.calls.map(([key]) => key)).toEqual([bound, bound]);

        await c.close();
      }
    );
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

// LAB-4839: normalize() used to send Uint8Array down the plain-object branch —
// under 10,000 bytes it came back as {"0":…}, over that it threw on the
// collection cap. Real File backend, L1 off, so every get() decodes from L2.
describe('Binary values (LAB-4839)', () => {
  let dir: string;
  const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
  // `got` is unknown on purpose: the bug returned a plain object, so this must
  // check the runtime type, not assume it.
  const expectSameBytes = (got: unknown, want: Uint8Array) => {
    assert(got instanceof Uint8Array, 'expected a Uint8Array');
    expect(Buffer.compare(got, want)).toBe(0);
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cachekit-binary-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips a Uint8Array through set/get and wrap', async () => {
    const c = createCache({ backend: file({ cacheDir: dir }), l1: { enabled: false } });

    for (const value of [bytes(3), bytes(20_000)]) {
      await c.set('bin:k', value);
      expectSameBytes(await c.get('bin:k'), value);
    }

    let calls = 0;
    const cached = c.wrap(
      async (n: number) => {
        calls++;
        return bytes(n);
      },
      { namespace: 'bin:fn', ttl: 60 }
    );
    expectSameBytes(await cached(20_000), bytes(20_000));
    expectSameBytes(await cached(20_000), bytes(20_000));
    expect(calls).toBe(1); // second call served from the backend, not recomputed

    await c.close();
  });
});
