/**
 * Write-behind on Workers — runs inside real workerd.
 *
 * workerd cancels fire-and-forget work at response return, so a write-behind
 * L2 write is only deferred when the function was wrapped through
 * `cache.withExecutionContext(ctx)`, which registers it with `ctx.waitUntil`.
 * Wrapped on the base cache, the write stays on the caller's path.
 */

import { describe, it, expect } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createCache, type Backend } from '../../src/workers/index.js';

interface GateState {
  store: Map<string, Uint8Array>;
  sets: number;
  hold: Promise<void> | null;
  gate(): void;
  open(): void;
}

/** In-memory Backend whose set() waits while `hold` is set. */
function gatedBackend() {
  let release: () => void = () => {};
  const state: GateState = {
    store: new Map<string, Uint8Array>(),
    sets: 0,
    hold: null,
    gate() {
      state.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    open() {
      release();
      state.hold = null;
    },
  };
  const backend: Backend = {
    async get(key) {
      return state.store.get(key) ?? null;
    },
    async set(key, value) {
      if (state.hold) await state.hold;
      state.store.set(key, value);
      state.sets++;
    },
    async delete(key) {
      return state.store.delete(key);
    },
    async exists(key) {
      return state.store.has(key);
    },
    async close() {},
  };
  return { backend, state };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('write-behind inside workerd', () => {
  it('returns before the PUT, which completes under ctx.waitUntil', async () => {
    const { backend, state } = gatedBackend();
    state.gate();
    const cache = createCache({ backend, defaultTtl: 60 });
    const ctx = createExecutionContext();
    // Capture what the cache registers, then hand it to the real context.
    const registered: Promise<unknown>[] = [];
    const fn = cache
      .withExecutionContext({
        waitUntil: (promise) => {
          registered.push(promise);
          ctx.waitUntil(promise);
        },
      })
      .wrap(async (id: number) => ({ id }), { namespace: 'wb:ctx', ttl: 60, writeBehind: true });

    expect(await fn(1)).toEqual({ id: 1 });
    expect(state.sets).toBe(0); // returned with the PUT still pending
    expect(registered).toHaveLength(1); // the pending write is registered
    let settled = false;
    void registered[0].then(() => (settled = true));
    await settle();
    expect(settled).toBe(false); // and registered as the write itself, still pending

    state.open();
    await waitOnExecutionContext(ctx);
    expect(settled).toBe(true);
    expect(state.sets).toBe(1);
    expect(state.store.size).toBe(1);
    await cache.close();
  });

  it('wrapped on the base cache (no waitUntil), the PUT stays on the caller', async () => {
    const { backend, state } = gatedBackend();
    state.gate();
    const cache = createCache({ backend, defaultTtl: 60 });
    const fn = cache.wrap(async (id: number) => ({ id }), {
      namespace: 'wb:base',
      ttl: 60,
      writeBehind: true,
    });

    let returned = false;
    const call = fn(2).then(() => {
      returned = true;
    });
    await settle();
    expect(returned).toBe(false);

    state.open();
    await call;
    expect(state.sets).toBe(1);
    await cache.close();
  });
});
