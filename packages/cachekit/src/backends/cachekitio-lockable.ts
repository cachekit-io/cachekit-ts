import type { LockableBackend } from './types.js';
import { CachekitIOCore } from './cachekitio.js';
import { BackendError, TimeoutError } from '../errors.js';
import { classifyHttpError, classifyNetworkError } from './error-classifier.js';

export class LockableCachekitIO implements LockableBackend {
  constructor(private readonly inner: CachekitIOCore) {}

  get(key: string) { return this.inner.get(key); }
  set(key: string, value: Uint8Array, ttl?: number) { return this.inner.set(key, value, ttl); }
  delete(key: string) { return this.inner.delete(key); }
  exists(key: string) { return this.inner.exists(key); }
  close() { return this.inner.close(); }

  async acquireLock(key: string, timeoutMs = 5000): Promise<string | null> {
    try {
      const url = `${this.inner['apiUrl']}/v1/cache/${encodeURIComponent(key)}/lock`;
      const response = await this.inner.requestJson('POST', url, { timeout_ms: timeoutMs });
      if (!response.ok) throw new BackendError(
        `Lock acquire failed (HTTP ${response.status})`, classifyHttpError(response.status));
      const body = await response.json() as { lock_id: string | null };
      return body.lock_id;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (error instanceof Error) {
        const classification = classifyNetworkError(error);
        if (classification === 'timeout') {
          throw new TimeoutError(`Lock acquire timed out: ${error.message}`, { cause: error });
        }
        throw new BackendError(`Lock acquire failed: ${error.message}`, classification, { cause: error });
      }
      throw new BackendError('Lock acquire failed: Unknown error');
    }
  }

  async releaseLock(key: string, lockId: string): Promise<boolean> {
    try {
      const url = `${this.inner['apiUrl']}/v1/cache/${encodeURIComponent(key)}/lock?lock_id=${encodeURIComponent(lockId)}`;
      const response = await this.inner.requestJson('DELETE', url);
      if (!response.ok) throw new BackendError(
        `Lock release failed (HTTP ${response.status})`, classifyHttpError(response.status));
      return true;
    } catch (error) {
      if (error instanceof BackendError) throw error;
      if (error instanceof Error) {
        const classification = classifyNetworkError(error);
        if (classification === 'timeout') {
          throw new TimeoutError(`Lock release timed out: ${error.message}`, { cause: error });
        }
        throw new BackendError(`Lock release failed: ${error.message}`, classification, { cause: error });
      }
      throw new BackendError('Lock release failed: Unknown error');
    }
  }
}
