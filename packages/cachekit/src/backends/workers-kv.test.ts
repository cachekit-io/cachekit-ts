import { describe, it, expect } from 'vitest';
import { WorkersKVBackend, type KVNamespaceLike } from './workers-kv.js';

/**
 * Node-lane unit tests for delete()'s eventual-consistency handling. The
 * real-workerd behavior (a miniflare KVNamespace) is covered by
 * test/workers/edge-backends — miniflare is strongly consistent locally, so
 * it cannot produce a read-ahead that misses an entry KV still holds.
 */
class StaleReadKV implements KVNamespaceLike {
  readonly deleted: string[] = [];

  // A cached negative lookup, or a write from another location that has not
  // propagated here yet: the read misses although the entry exists.
  async get(): Promise<ArrayBuffer | null> {
    return null;
  }

  async put(): Promise<void> {}

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
}

describe('WorkersKVBackend.delete (unit, KV double)', () => {
  it('issues kv.delete even when the read-ahead returns null', async () => {
    const kv = new StaleReadKV();
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:stale')).toBe(false);
    expect(kv.deleted).toEqual(['kv:stale']);
  });
});
