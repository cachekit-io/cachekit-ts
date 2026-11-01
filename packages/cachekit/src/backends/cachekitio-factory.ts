import type { Backend, CachekitIOBackendConfig, LockableBackend, TTLBackend } from './types.js';
import { CachekitIOCore } from './cachekitio.js';
import { LockableCachekitIO } from './cachekitio-lockable.js';
import { TTLCachekitIO } from './cachekitio-ttl.js';
import type { L1LatencyReport } from './telemetry.js';

export function cachekitio(config: CachekitIOBackendConfig): Backend {
  return new CachekitIOCore(config);
}

export function cachekitioWithLocking(config: CachekitIOBackendConfig): LockableBackend {
  return new LockableCachekitIO(new CachekitIOCore(config));
}

export function cachekitioWithTTL(config: CachekitIOBackendConfig): TTLBackend {
  return new TTLCachekitIO(new CachekitIOCore(config));
}

// Required<…getWithTtl | setWithStaleTtl>: tsc, not only tests, enforces the forwards.
class CachekitIO
  implements LockableBackend, TTLBackend, Required<Pick<Backend, 'getWithTtl' | 'setWithStaleTtl'>>
{
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
  /** @internal Forwarded like keyPrefix — see Backend.l1Latency. */
  get l1Latency(): L1LatencyReport | undefined {
    return this.lockable.l1Latency;
  }
  get(key: string) {
    return this.lockable.get(key);
  }
  // MUST forward: see Backend.getWithTtl.
  getWithTtl(key: string) {
    return this.lockable.getWithTtl(key);
  }
  set(key: string, value: Uint8Array, ttl?: number) {
    return this.lockable.set(key, value, ttl);
  }
  // MUST forward: see Backend.setWithStaleTtl.
  setWithStaleTtl(key: string, value: Uint8Array, ttl: number, staleTtl: number) {
    return this.lockable.setWithStaleTtl(key, value, ttl, staleTtl);
  }
  // Forwarded like keyPrefix — hiding it would let CacheImpl's reliability
  // stack swallow the inner backend's TTL rejection. See Backend.validateTtl.
  validateTtl(ttl: number) {
    this.lockable.validateTtl(ttl);
  }
  validateKey(key: string) {
    this.lockable.validateKey(key);
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
