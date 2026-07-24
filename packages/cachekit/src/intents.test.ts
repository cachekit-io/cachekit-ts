import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CacheOptions } from './types/cache.js';

// Mock the raw createCache to capture options without connecting to Redis/SaaS
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  exists: vi.fn(),
  wrap: vi.fn(),
  with: vi.fn(),
  invalidate: vi.fn(),
  close: mockClose,
  secure: { wrap: vi.fn() },
};

let capturedOptions: CacheOptions | null = null;

vi.mock('./cache.js', () => ({
  createCache: (options: CacheOptions) => {
    capturedOptions = options;
    return mockCache;
  },
}));

// Import AFTER mock setup
const { createCache } = await import('./intents.js');
const { ConfigurationError } = await import('./errors.js');

describe('Intent-based Cache API', () => {
  beforeEach(() => {
    capturedOptions = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CACHEKIT_MASTER_KEY;
    delete process.env.CACHEKIT_API_KEY;
  });

  // ========================================================================
  // createCache.minimal()
  // ========================================================================
  describe('createCache.minimal()', () => {
    it('creates cache with Redis backend and no reliability', () => {
      createCache.minimal({ url: 'redis://localhost:6379' });

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions!.backend).toEqual({ url: 'redis://localhost:6379' });
      expect(capturedOptions!.defaultTtl).toBe(300);
      expect(capturedOptions!.reliability?.degradation).toBe(false);
      expect(capturedOptions!.reliability?.circuitBreaker?.failureThreshold).toBe(Infinity);
    });

    it('disables SWR and invalidation on L1', () => {
      createCache.minimal({ url: 'redis://localhost:6379' });

      expect(capturedOptions!.l1?.swrEnabled).toBe(false);
      expect(capturedOptions!.l1?.invalidationEnabled).toBe(false);
      expect(capturedOptions!.l1?.namespaceIndex).toBe(false);
    });

    it('respects TTL override', () => {
      createCache.minimal({ url: 'redis://localhost:6379', ttl: 120 });

      expect(capturedOptions!.defaultTtl).toBe(120);
    });

    it('passes keyPrefix to backend config', () => {
      createCache.minimal({ url: 'redis://localhost:6379', keyPrefix: 'app:' });

      expect(capturedOptions!.backend).toEqual({
        url: 'redis://localhost:6379',
        keyPrefix: 'app:',
      });
    });

    it('does not enable metrics', () => {
      createCache.minimal({ url: 'redis://localhost:6379' });

      expect(capturedOptions!.metrics).toBeUndefined();
    });
  });

  // ========================================================================
  // createCache.production()
  // ========================================================================
  describe('createCache.production()', () => {
    it('creates cache with Redis backend and full reliability', () => {
      createCache.production({ url: 'redis://localhost:6379' });

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions!.backend).toEqual({ url: 'redis://localhost:6379' });
      expect(capturedOptions!.defaultTtl).toBe(600);
      expect(capturedOptions!.reliability?.circuitBreaker?.failureThreshold).toBe(5);
      expect(capturedOptions!.reliability?.circuitBreaker?.successThreshold).toBe(3);
      expect(capturedOptions!.reliability?.retry?.maxAttempts).toBe(3);
      expect(capturedOptions!.reliability?.degradation).toBe(true);
    });

    it('enables full L1 with SWR', () => {
      createCache.production({ url: 'redis://localhost:6379' });

      expect(capturedOptions!.l1?.swrEnabled).toBe(true);
      expect(capturedOptions!.l1?.invalidationEnabled).toBe(true);
      expect(capturedOptions!.l1?.namespaceIndex).toBe(true);
    });

    it('enables metrics by default', () => {
      createCache.production({ url: 'redis://localhost:6379' });

      expect(capturedOptions!.metrics).toBe(true);
    });

    it('allows disabling metrics', () => {
      createCache.production({ url: 'redis://localhost:6379', metrics: false });

      expect(capturedOptions!.metrics).toBe(false);
    });

    it('allows overriding circuit breaker settings', () => {
      createCache.production({
        url: 'redis://localhost:6379',
        reliability: { circuitBreaker: { failureThreshold: 20 } },
      });

      expect(capturedOptions!.reliability?.circuitBreaker?.failureThreshold).toBe(20);
      // Other defaults preserved
      expect(capturedOptions!.reliability?.circuitBreaker?.successThreshold).toBe(3);
    });

    it('respects L1 config overrides', () => {
      createCache.production({
        url: 'redis://localhost:6379',
        l1: { maxEntries: 500, swrEnabled: false },
      });

      expect(capturedOptions!.l1?.maxEntries).toBe(500);
      expect(capturedOptions!.l1?.swrEnabled).toBe(false);
      // Defaults still applied for unset fields
      expect(capturedOptions!.l1?.invalidationEnabled).toBe(true);
    });
  });

  // ========================================================================
  // createCache.secure()
  // ========================================================================
  describe('createCache.secure()', () => {
    const MASTER_KEY = 'a'.repeat(64);

    it('creates cache with encryption and production reliability', () => {
      createCache.secure({ url: 'redis://localhost:6379', masterKey: MASTER_KEY });

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions!.encryption?.masterKey).toBe(MASTER_KEY);
      expect(capturedOptions!.reliability?.circuitBreaker?.failureThreshold).toBe(5);
      expect(capturedOptions!.reliability?.degradation).toBe(true);
      expect(capturedOptions!.defaultTtl).toBe(600);
    });

    it('passes tenantId to encryption config', () => {
      createCache.secure({
        url: 'redis://localhost:6379',
        masterKey: MASTER_KEY,
        tenantId: 'tenant-123',
      });

      expect(capturedOptions!.encryption?.tenantId).toBe('tenant-123');
    });

    it('resolves masterKey from env var', () => {
      process.env.CACHEKIT_MASTER_KEY = MASTER_KEY;

      createCache.secure({ url: 'redis://localhost:6379' });

      expect(capturedOptions!.encryption?.masterKey).toBe(MASTER_KEY);
    });

    it('throws ConfigurationError without masterKey', () => {
      expect(() => {
        createCache.secure({ url: 'redis://localhost:6379' });
      }).toThrow(ConfigurationError);
    });

    it('throws with helpful error message', () => {
      expect(() => {
        createCache.secure({ url: 'redis://localhost:6379' });
      }).toThrow(/master key/i);
    });

    it('explicit masterKey takes precedence over env var', () => {
      process.env.CACHEKIT_MASTER_KEY = 'b'.repeat(64);

      createCache.secure({ url: 'redis://localhost:6379', masterKey: MASTER_KEY });

      expect(capturedOptions!.encryption?.masterKey).toBe(MASTER_KEY);
    });
  });

  // ========================================================================
  // createCache.io()
  // ========================================================================
  describe('createCache.io()', () => {
    it('creates cache with CachekitIO backend', () => {
      createCache.io({ apiKey: 'ck_live_test123' });

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions!.backend).toEqual(
        expect.objectContaining({
          apiKey: 'ck_live_test123',
        })
      );
      expect(capturedOptions!.defaultTtl).toBe(3600);
    });

    it('passes apiUrl and timeout', () => {
      createCache.io({
        apiKey: 'ck_live_test123',
        apiUrl: 'https://custom.endpoint.io',
        timeout: 10000,
      });

      expect(capturedOptions!.backend).toEqual(
        expect.objectContaining({
          apiKey: 'ck_live_test123',
          apiUrl: 'https://custom.endpoint.io',
          timeout: 10000,
        })
      );
    });

    it('enables production-grade reliability', () => {
      createCache.io({ apiKey: 'ck_live_test123' });

      expect(capturedOptions!.reliability?.circuitBreaker?.failureThreshold).toBe(5);
      expect(capturedOptions!.reliability?.retry?.maxAttempts).toBe(3);
      expect(capturedOptions!.reliability?.degradation).toBe(true);
    });

    it('resolves apiKey from env var', () => {
      process.env.CACHEKIT_API_KEY = 'ck_live_from_env';

      createCache.io({});

      expect(capturedOptions!.backend).toEqual(
        expect.objectContaining({
          apiKey: 'ck_live_from_env',
        })
      );
    });

    it('throws ConfigurationError without apiKey', () => {
      expect(() => {
        createCache.io({});
      }).toThrow(ConfigurationError);
    });

    it('throws with helpful error message', () => {
      expect(() => {
        createCache.io({});
      }).toThrow(/API key/i);
    });

    it('supports optional encryption', () => {
      const masterKey = 'c'.repeat(64);

      createCache.io({
        apiKey: 'ck_live_test123',
        encryption: { masterKey },
      });

      expect(capturedOptions!.encryption?.masterKey).toBe(masterKey);
    });

    it('enables metrics by default', () => {
      createCache.io({ apiKey: 'ck_live_test123' });

      expect(capturedOptions!.metrics).toBe(true);
    });
  });

  // ========================================================================
  // Backend instances through the storage-agnostic intents (LAB-750)
  // ========================================================================
  describe('backend instances in minimal/production/secure', () => {
    const instanceBackend = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      close: vi.fn(),
    };

    it.each(['minimal', 'production', 'secure'] as const)(
      'createCache.%s() passes a backend instance through untouched',
      (intent) => {
        createCache[intent]({
          backend: instanceBackend,
          ...(intent === 'secure' ? { masterKey: 'a'.repeat(64) } : {}),
        });

        expect(capturedOptions!.backend).toBe(instanceBackend);
      }
    );

    it.each(['minimal', 'production', 'secure'] as const)(
      'createCache.%s() rejects url and backend together',
      (intent) => {
        expect(() =>
          createCache[intent]({
            url: 'redis://localhost:6379',
            backend: instanceBackend,
            ...(intent === 'secure' ? { masterKey: 'a'.repeat(64) } : {}),
          } as never)
        ).toThrow(ConfigurationError);
      }
    );

    it.each(['minimal', 'production', 'secure'] as const)(
      'createCache.%s() rejects neither url nor backend',
      (intent) => {
        expect(() =>
          createCache[intent]({
            ...(intent === 'secure' ? { masterKey: 'a'.repeat(64) } : {}),
          } as never)
        ).toThrow(/requires a Redis url or a backend instance/);
      }
    );
  });

  // ========================================================================
  // createCache() — original API unchanged
  // ========================================================================
  describe('createCache() (original)', () => {
    it('still works with explicit CacheOptions', () => {
      const backend = {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        exists: vi.fn(),
        close: vi.fn(),
      };

      createCache({ backend, defaultTtl: 1800 });

      expect(capturedOptions!.backend).toBe(backend);
      expect(capturedOptions!.defaultTtl).toBe(1800);
    });
  });
});
