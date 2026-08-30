import type { TTLBackend } from './types.js';
import { CachekitIOCore, validateTtl } from './cachekitio.js';
import { BackendError, TimeoutError } from '../errors.js';
import { classifyHttpError, classifyNetworkError } from './error-classifier.js';

export class TTLCachekitIO implements TTLBackend {
  constructor(private readonly inner: CachekitIOCore) {}

  // Delegating wrappers MUST forward keyPrefix / transformsKeys — see Backend.keyPrefix.
  get keyPrefix(): string | undefined {
    return this.inner.keyPrefix;
  }
  get transformsKeys(): boolean | undefined {
    return this.inner.transformsKeys;
  }

  get(key: string) {
    return this.inner.get(key);
  }
  set(key: string, value: Uint8Array, ttl?: number) {
    return this.inner.set(key, value, ttl);
  }
  // Forwarded like keyPrefix — hiding it would let CacheImpl's reliability
  // stack swallow the inner backend's TTL rejection. See Backend.validateTtl.
  validateTtl(ttl: number) {
    this.inner.validateTtl(ttl);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
  close() {
    return this.inner.close();
  }

  async getTTL(key: string): Promise<number | null> {
    try {
      const url = `${this.inner['apiUrl']}/v1/cache/${encodeURIComponent(key)}/ttl`;
      const response = await this.inner.requestJson('GET', url);
      if (response.status === 404) return null;
      if (!response.ok)
        throw new BackendError(
          `TTL get failed (HTTP ${response.status})`,
          classifyHttpError(response.status)
        );
      const body = (await response.json()) as { ttl: number | null };
      return body.ttl;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (error instanceof Error) {
        const classification = classifyNetworkError(error);
        if (classification === 'timeout') {
          throw new TimeoutError(`TTL get timed out: ${error.message}`, { cause: error });
        }
        throw new BackendError(`TTL get failed: ${error.message}`, classification, {
          cause: error,
        });
      }
      throw new BackendError('TTL get failed: Unknown error');
    }
  }

  async refreshTTL(key: string, ttl: number): Promise<boolean> {
    // Same normative rules as X-CacheKit-TTL (spec: PATCH body follows them).
    // Before the try — the catch below would wrap it as a BackendError.
    const validTtl = validateTtl(ttl);
    try {
      const url = `${this.inner['apiUrl']}/v1/cache/${encodeURIComponent(key)}/ttl`;
      const response = await this.inner.requestJson('PATCH', url, { ttl: validTtl });
      if (response.status === 404) return false;
      if (!response.ok)
        throw new BackendError(
          `TTL refresh failed (HTTP ${response.status})`,
          classifyHttpError(response.status)
        );
      return true;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (error instanceof Error) {
        const classification = classifyNetworkError(error);
        if (classification === 'timeout') {
          throw new TimeoutError(`TTL refresh timed out: ${error.message}`, { cause: error });
        }
        throw new BackendError(`TTL refresh failed: ${error.message}`, classification, {
          cause: error,
        });
      }
      throw new BackendError('TTL refresh failed: Unknown error');
    }
  }
}
