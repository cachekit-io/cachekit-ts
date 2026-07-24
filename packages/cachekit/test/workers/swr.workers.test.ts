/**
 * SWR on Workers via ctx.waitUntil (LAB-751) — runs inside real workerd.
 *
 * Phase 1 (LAB-595) forced SWR off on Workers: workerd cancels
 * fire-and-forget work at response return, so a background refresh died
 * mid-flight and left its key wedged in a permanent "refreshing" state.
 * Phase 2 re-enables it behind a per-request binding —
 * `cache.withExecutionContext(ctx)` — that registers each refresh with the
 * platform via `ctx.waitUntil`. These tests prove the acceptance criteria
 * against real ExecutionContexts (`createExecutionContext` /
 * `waitOnExecutionContext` from cloudflare:test):
 *
 * - a stale L1 hit serves immediately and the refresh completes under
 *   waitUntil (L1 and L2 both updated);
 * - concurrent stale hits single-flight (one refresh, not N);
 * - a failing refresh clears its marker instead of wedging the key;
 * - without a bound context, reads fail safe to plain (no-SWR) L1 gets —
 *   no refresh is scheduled, and the key stays refreshable for later
 *   context-bound calls.
 *
 * `swrThresholdRatio: 2` makes every live L1 entry deterministically stale
 * (threshold = originalTtl * ratio * jitter ≥ 1.8×ttl > remaining TTL), so
 * no clock manipulation is needed inside workerd.
 */

import { describe, it, expect } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createCache, type Backend } from '../../src/workers/index.js';

/** In-memory Backend that counts writes, so L2 persistence is observable. */
function memoryBackend(): Backend & { store: Map<string, Uint8Array>; setCalls: number } {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    setCalls: 0,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      this.setCalls++;
      store.set(key, value);
    },
    async delete(key) {
      return store.delete(key);
    },
    async exists(key) {
      return store.has(key);
    },
    async close() {},
  };
}

const ALWAYS_STALE_L1 = { swrEnabled: true, swrThresholdRatio: 2 };

describe('SWR via ctx.waitUntil inside workerd', () => {
  it('serves the stale value immediately and completes the refresh under waitUntil', async () => {
    const backend = memoryBackend();
    const cache = createCache({ backend, defaultTtl: 60, l1: ALWAYS_STALE_L1 });
    const ctx = createExecutionContext();
    const bound = cache.withExecutionContext(ctx);

    let calls = 0;
    const fn = bound.wrap(
      async (id: number) => {
        calls++;
        return { id, gen: calls };
      },
      { namespace: 'swr:refresh', ttl: 60 }
    );

    expect(await fn(1)).toEqual({ id: 1, gen: 1 }); // cold miss computes
    expect(backend.setCalls).toBe(1);

    // Stale L1 hit: the OLD value is returned immediately even though the
    // refresh (gen 2) has already been scheduled.
    expect(await fn(1)).toEqual({ id: 1, gen: 1 });

    // waitUntil keeps the refresh alive to completion: L2 re-written…
    await waitOnExecutionContext(ctx);
    expect(backend.setCalls).toBe(2);

    // …and L1 now holds the refreshed value.
    expect(await fn(1)).toEqual({ id: 1, gen: 2 });

    await waitOnExecutionContext(ctx); // drain the refresh that read scheduled
    await cache.close();
  });

  it('single-flights concurrent stale hits — one refresh, not N', async () => {
    const backend = memoryBackend();
    const cache = createCache({ backend, defaultTtl: 60, l1: ALWAYS_STALE_L1 });
    const ctx = createExecutionContext();
    const bound = cache.withExecutionContext(ctx);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let calls = 0;
    const fn = bound.wrap(
      async () => {
        calls++;
        if (calls > 1) await gate; // hold every refresh in flight
        return { gen: calls };
      },
      { namespace: 'swr:singleflight', ttl: 60 }
    );

    expect(await fn()).toEqual({ gen: 1 }); // cold miss

    // Three stale hits while the first refresh is held in flight: all serve
    // the stale value, and the refresh marker prevents piling on.
    expect(await fn()).toEqual({ gen: 1 });
    expect(await fn()).toEqual({ gen: 1 });
    expect(await fn()).toEqual({ gen: 1 });
    expect(calls).toBe(2); // initial compute + exactly ONE refresh

    release();
    await waitOnExecutionContext(ctx);
    expect(await fn()).toEqual({ gen: 2 });

    await waitOnExecutionContext(ctx);
    await cache.close();
  });

  it('a failing refresh clears its marker instead of wedging the key', async () => {
    const backend = memoryBackend();
    const cache = createCache({ backend, defaultTtl: 60, l1: ALWAYS_STALE_L1 });
    const ctx = createExecutionContext();
    const bound = cache.withExecutionContext(ctx);

    let calls = 0;
    let failNext = false;
    const fn = bound.wrap(
      async () => {
        calls++;
        if (failNext) {
          failNext = false;
          throw new Error('refresh boom');
        }
        return { gen: calls };
      },
      { namespace: 'swr:failure', ttl: 60 }
    );

    expect(await fn()).toEqual({ gen: 1 }); // cold miss

    failNext = true;
    expect(await fn()).toEqual({ gen: 1 }); // stale hit schedules refresh #1 (call 2 — fails)
    await waitOnExecutionContext(ctx);

    // The failed refresh cancelled its marker, so the key is refreshable
    // again — the next stale hit schedules refresh #2 (call 3), which lands.
    expect(await fn()).toEqual({ gen: 1 }); // L1 untouched by the failed refresh
    expect(calls).toBe(3);
    await waitOnExecutionContext(ctx);
    expect(await fn()).toEqual({ gen: 3 });

    await waitOnExecutionContext(ctx);
    await cache.close();
  });

  it('fails safe without a bound context: plain L1 reads, no refresh, no wedge', async () => {
    const backend = memoryBackend();
    const cache = createCache({ backend, defaultTtl: 60, l1: ALWAYS_STALE_L1 });

    let calls = 0;
    const compute = async () => {
      calls++;
      return { gen: calls };
    };
    const options = { namespace: 'swr:unbound', ttl: 60 } as const;

    const unbound = cache.wrap(compute, options);
    expect(await unbound()).toEqual({ gen: 1 }); // cold miss
    expect(await unbound()).toEqual({ gen: 1 }); // plain L1 hit — no SWR read

    // Nothing was scheduled fire-and-forget: the compute count stays put
    // even after pending microtasks/macrotasks drain.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);

    // The unbound reads took no refresh marker, so the same key refreshes
    // normally once a request context IS bound (same namespace + args ⇒
    // same cache key, shared L1).
    const ctx = createExecutionContext();
    const boundFn = cache.withExecutionContext(ctx).wrap(compute, options);
    expect(await boundFn()).toEqual({ gen: 1 }); // stale hit, schedules refresh
    await waitOnExecutionContext(ctx);
    expect(await boundFn()).toEqual({ gen: 2 });

    await waitOnExecutionContext(ctx);
    await cache.close();
  });
});
