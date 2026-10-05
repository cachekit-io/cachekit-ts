import { describe, it, expect, afterEach, vi } from 'vitest';
import { BackendError } from '../errors.js';
import { setLogger } from '../logger.js';
import { blake2b16Hex } from '../serialization/key-generator.js';
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
  afterEach(() => {
    setLogger(null);
  });

  it('issues kv.delete even when the read-ahead returns null', async () => {
    const kv = new KVDouble();
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:stale')).toBe(false);
    expect(kv.deleted).toEqual(['kv:stale']);
  });

  it('issues kv.delete even when the read-ahead rejects, and reports it by digest', async () => {
    const log = vi.fn();
    setLogger(log);
    const kv = new KVDouble(async () => {
      throw new Error('KV GET failed: 503 for kv:flaky');
    });
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:flaky')).toBe(false);
    expect(kv.deleted).toEqual(['kv:flaky']);
    expect(log).toHaveBeenCalledOnce();
    const [message, error] = log.mock.calls[0]!;
    expect(message).toContain('read-ahead failed (transient)');
    expect(message).toContain(`keyHash=${blake2b16Hex('kv:flaky')}`);
    // Neither the key nor the error text (which here embeds the key) is logged.
    expect(message).not.toContain('kv:flaky');
    expect(error).toBeUndefined();
  });

  it('issues kv.delete even when the rejected read-ahead error cannot be classified', async () => {
    const log = vi.fn();
    setLogger(log);
    const hostile = new Error();
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('message getter threw');
      },
    });
    const kv = new KVDouble(async () => {
      throw hostile;
    });
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:hostile')).toBe(false);
    expect(kv.deleted).toEqual(['kv:hostile']);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain('read-ahead failed (unknown)');
  });

  it('issues kv.delete and reports unknown when the read-ahead rejects with a non-Error', async () => {
    const log = vi.fn();
    setLogger(log);
    const kv = new KVDouble(() => Promise.reject('KV GET failed: 503'));
    const backend = new WorkersKVBackend({ kv });

    expect(await backend.delete('kv:non-error')).toBe(false);
    expect(kv.deleted).toEqual(['kv:non-error']);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toContain('read-ahead failed (unknown)');
  });

  it('does not log when the read-ahead succeeds', async () => {
    const log = vi.fn();
    setLogger(log);
    const backend = new WorkersKVBackend({ kv: new KVDouble() });

    await backend.delete('kv:stale');
    expect(log).not.toHaveBeenCalled();
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
