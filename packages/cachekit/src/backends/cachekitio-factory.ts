import type { Backend, CachekitIOBackendConfig, LockableBackend, TTLBackend } from './types.js';
import { CachekitIOCore } from './cachekitio.js';
import { LockableCachekitIO } from './cachekitio-lockable.js';
import { TTLCachekitIO } from './cachekitio-ttl.js';

export function cachekitio(config: CachekitIOBackendConfig): Backend {
  return new CachekitIOCore(config);
}

export function cachekitioWithLocking(config: CachekitIOBackendConfig): LockableBackend {
  return new LockableCachekitIO(new CachekitIOCore(config));
}

export function cachekitioWithTTL(config: CachekitIOBackendConfig): TTLBackend {
  return new TTLCachekitIO(new CachekitIOCore(config));
}

class CachekitIO implements LockableBackend, TTLBackend {
  private readonly lockable: LockableCachekitIO;
  private readonly ttl: TTLCachekitIO;

  constructor(config: CachekitIOBackendConfig) {
    const core = new CachekitIOCore(config);
    this.lockable = new LockableCachekitIO(core);
    this.ttl = new TTLCachekitIO(core);
  }

  // Delegating wrappers MUST forward keyPrefix / transformsKeys — see Backend.keyPrefix.
  get keyPrefix(): string | undefined {
    return this.lockable.keyPrefix;
  }
  get transformsKeys(): boolean | undefined {
    return this.lockable.transformsKeys;
  }
  get(key: string) {
    return this.lockable.get(key);
  }
  set(key: string, value: Uint8Array, ttl?: number) {
    return this.lockable.set(key, value, ttl);
  }
  // Forwarded like keyPrefix — hiding it would let CacheImpl's reliability
  // stack swallow the inner backend's TTL rejection. See Backend.validateTtl.
  validateTtl(ttl: number) {
    this.lockable.validateTtl(ttl);
  }
  delete(key: string) {
    return this.lockable.delete(key);
  }
  exists(key: string) {
    return this.lockable.exists(key);
  }
  close() {
    return this.lockable.close();
  }
  acquireLock(key: string, timeoutMs?: number) {
    return this.lockable.acquireLock(key, timeoutMs);
  }
  releaseLock(key: string, lockId: string) {
    return this.lockable.releaseLock(key, lockId);
  }
  getTTL(key: string) {
    return this.ttl.getTTL(key);
  }
  refreshTTL(key: string, ttl: number) {
    return this.ttl.refreshTTL(key, ttl);
  }
}

export function cachekitioFull(config: CachekitIOBackendConfig): LockableBackend & TTLBackend {
  return new CachekitIO(config);
}
