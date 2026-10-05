import { describe, it, expect } from 'vitest';
import { BackendError } from '../errors.js';
import { WorkersKVBackend, type KVNamespaceLike } from './workers-kv.js';

/**
 * Node-lane unit tests for delete()'s eventual-consistency handling. The
 * real-workerd behavior (a miniflare KVNamespace) is covered by
 * test/workers/edge-backends — miniflare is strongly consistent locally, so
 * it cannot produce a read-ahead that misses an entry KV still holds.
 */
class KVDouble implements KVNamespaceLike {
  readonly deleted: string[] = [];

  constructor(
    // Default: a cached negative lookup, or a write from another location
    // that has not propagated here yet — the read misses although the entry
    // exists.
    private readonly read: () => Promise<ArrayBuffer | null> = async () => null,
    private readonly remove: () => Promise<void> = async () => {}
  ) {}

  async get(): Promise<ArrayBuffer | null> {
    return this.read();
  }

  async put(): Promise<void> {}

  async delete(key: string): Promise<void> {
    await this.remove();
    this.deleted.push(key);
  }
}

describe('WorkersKVBackend.delete (unit, KV double)', () => {
  it('issues kv.delete even when the read-ahead returns null', async () => {
    const kv = new KVDouble();
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:stale')).toBe(false);
    expect(kv.deleted).toEqual(['kv:stale']);
  });

  it('issues kv.delete even when the read-ahead rejects', async () => {
    const kv = new KVDouble(async () => {
      throw new Error('KV GET failed: 503');
    });
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:flaky')).toBe(false);
    expect(kv.deleted).toEqual(['kv:flaky']);
  });

  it('still rejects with BackendError when kv.delete itself fails', async () => {
    const kv = new KVDouble(
      async () => new ArrayBuffer(1),
      async () => {
        throw new Error('KV DELETE failed: 503');
      }
    );
    const backend = new WorkersKVBackend({ kv });

    await expect(backend.delete('kv:key')).rejects.toBeInstanceOf(BackendError);
  });
});
