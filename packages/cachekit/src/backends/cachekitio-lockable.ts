import type { LockableBackend } from './types.js';
import { CachekitIOCore } from './cachekitio.js';
import { BackendError, TimeoutError } from '../errors.js';
import { classifyHttpError, classifyNetworkError } from './error-classifier.js';

/**
 * Lock capability token travels in this request header, never the query string
 * (CWE-532): a `?lock_id=` query leaks the token into access/proxy logs and
 * OpenTelemetry `http.url` spans. SaaS dual-reads header + legacy query during
 * rollout, preferring the header. See protocol spec/saas-api.md.
 */
const LOCK_ID_HEADER = 'X-CacheKit-Lock-Id';

export class LockableCachekitIO implements LockableBackend {
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

  async acquireLock(key: string, timeoutMs = 5000): Promise<string | null> {
    try {
      const url = `${this.inner['apiUrl']}/v1/cache/${encodeURIComponent(key)}/lock`;
      const response = await this.inner.requestJson('POST', url, { timeout_ms: timeoutMs });
      // Contested lock: the protocol spec (saas-api.md) answers 409 Conflict;
      // the deployed SaaS currently answers 200 {lock_id: null}. Both mean
      // "not acquired" — treat them identically so stampede fallthrough works
      // against either server behavior.
      if (response.status === 409) return null;
      if (!response.ok)
        throw new BackendError(
          `Lock acquire failed (HTTP ${response.status})`,
          classifyHttpError(response.status)
        );
      const body = (await response.json()) as { lock_id: string | null };
      return body.lock_id;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (error instanceof Error) {
        const classification = classifyNetworkError(error);
        if (classification === 'timeout') {
          throw new TimeoutError(`Lock acquire timed out: ${error.message}`, { cause: error });
        }
        throw new BackendError(`Lock acquire failed: ${error.message}`, classification, {
          cause: error,
        });
      }
      throw new BackendError('Lock acquire failed: Unknown error');
    }
  }

  async releaseLock(key: string, lockId: string): Promise<boolean> {
    try {
      const url = `${this.inner['apiUrl']}/v1/cache/${encodeURIComponent(key)}/lock`;
      const response = await this.inner.requestJson('DELETE', url, undefined, {
        [LOCK_ID_HEADER]: lockId,
      });
      if (!response.ok)
        throw new BackendError(
          `Lock release failed (HTTP ${response.status})`,
          classifyHttpError(response.status)
        );
      return true;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (error instanceof Error) {
        const classification = classifyNetworkError(error);
        if (classification === 'timeout') {
          throw new TimeoutError(`Lock release timed out: ${error.message}`, { cause: error });
        }
        throw new BackendError(`Lock release failed: ${error.message}`, classification, {
          cause: error,
        });
      }
      throw new BackendError('Lock release failed: Unknown error');
    }
  }
}
