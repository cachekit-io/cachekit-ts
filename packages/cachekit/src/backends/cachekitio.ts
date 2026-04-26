import { Backend, CachekitIOBackendConfig } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';
import { DEFAULT_TTL_SECONDS } from '../constants.js';
import { getSessionHeaders } from './session.js';
import { buildMetricsHeaders } from './metrics-headers.js';
import { classifyHttpError, classifyNetworkError } from './error-classifier.js';
import { validateCachekitUrl } from './url-validator.js';

const DEFAULT_API_URL = 'https://api.cachekit.io';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * CachekitIO backend — HTTP client for the cachekit.io SaaS.
 *
 * Stores and retrieves opaque bytes via the cachekit.io REST API.
 * Encryption-agnostic: works identically with plaintext or encrypted data.
 *
 * Uses native `fetch` (Node 20+, zero dependencies).
 *
 * @example
 * ```typescript
 * const backend = cachekitio({
 *   apiKey: process.env.CACHEKIT_API_KEY!,
 * });
 * await backend.set('key', new Uint8Array([1, 2, 3]), 3600);
 * const value = await backend.get('key');
 * await backend.close();
 * ```
 */
export class CachekitIOCore implements Backend {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly defaultTtl: number;
  private readonly timeout: number;
  private readonly metricsProvider?: () => import('./types.js').L1Metrics | null;
  private closed = false;

  constructor(config: CachekitIOBackendConfig) {
    if (!config.apiKey) {
      throw new ConfigurationError('CachekitIO backend requires an apiKey');
    }

    const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
    validateCachekitUrl(apiUrl, config.allowCustomHost);

    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultTtl = config.defaultTtl ?? DEFAULT_TTL_SECONDS;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.metricsProvider = config.metricsProvider;
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.ensureNotClosed();

    try {
      const response = await this.request('GET', this.cacheUrl(key));

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw await this.httpError('get', response);
      }

      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof BackendError || error instanceof TimeoutError) throw error;
      throw this.wrapError('get', error);
    }
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();

    const effectiveTtl = ttl ?? this.defaultTtl;
    const headers: Record<string, string> = {};
    if (effectiveTtl > 0) {
      headers['X-TTL'] = String(effectiveTtl);
    }

    try {
      const response = await this.request('PUT', this.cacheUrl(key), {
        body: value,
        headers,
      });

      if (!response.ok) {
        throw await this.httpError('set', response);
      }
    } catch (error) {
      if (error instanceof BackendError || error instanceof TimeoutError) throw error;
      throw this.wrapError('set', error);
    }
  }

  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();

    try {
      const response = await this.request('DELETE', this.cacheUrl(key));

      if (response.status === 404) {
        return false;
      }

      if (!response.ok) {
        throw await this.httpError('delete', response);
      }

      return true;
    } catch (error) {
      if (error instanceof BackendError || error instanceof TimeoutError) throw error;
      throw this.wrapError('delete', error);
    }
  }

  async exists(key: string): Promise<boolean> {
    this.ensureNotClosed();

    try {
      const response = await this.request('HEAD', this.cacheUrl(key));

      if (response.status === 404) {
        return false;
      }

      if (!response.ok) {
        throw await this.httpError('exists', response);
      }

      return true;
    } catch (error) {
      if (error instanceof BackendError || error instanceof TimeoutError) throw error;
      throw this.wrapError('exists', error);
    }
  }

  async close(): Promise<void> {
    // Native fetch has no persistent connection to close.
    this.closed = true;
  }

  async health(): Promise<{ healthy: boolean; latencyMs: number; version?: string }> {
    const start = performance.now();
    try {
      const response = await this.request('GET', `${this.apiUrl}/v1/cache/health`);
      const latencyMs = performance.now() - start;
      if (response.status === 429) return { healthy: false, latencyMs };
      if (!response.ok) return { healthy: false, latencyMs };
      const body = (await response.json()) as { version?: string };
      return { healthy: true, latencyMs, version: body.version };
    } catch {
      return { healthy: false, latencyMs: performance.now() - start };
    }
  }

  /** Package-internal: JSON request for lock/TTL decorators. Not part of public API. */
  async requestJson(method: string, url: string, body?: unknown): Promise<Response> {
    return this.request(method, url, {
      body: body ? new TextEncoder().encode(JSON.stringify(body)) : undefined,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    });
  }

  // ── Internal ──────────────────────────────────────────────

  private cacheUrl(key: string): string {
    return `${this.apiUrl}/v1/cache/${encodeURIComponent(key)}`;
  }

  private async request(
    method: string,
    url: string,
    opts?: { body?: Uint8Array; headers?: Record<string, string> }
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...getSessionHeaders(),
      ...buildMetricsHeaders(this.metricsProvider),
      ...opts?.headers,
    };
    if (opts?.body) {
      headers['Content-Type'] = opts.headers?.['Content-Type'] ?? 'application/octet-stream';
    }

    return fetch(url, {
      method,
      headers,
      body: opts?.body,
      signal: AbortSignal.timeout(this.timeout),
    });
  }

  private async httpError(operation: string, response: Response): Promise<BackendError> {
    const status = response.status;
    const classification = classifyHttpError(status);
    let detail: string;
    try {
      detail = (await response.text()).slice(0, 200);
    } catch {
      detail = response.statusText;
    }
    const message = this.sanitize(`CachekitIO ${operation} failed (HTTP ${status}): ${detail}`);
    return new BackendError(message, classification);
  }

  private wrapError(operation: string, error: unknown): Error {
    if (error instanceof Error) {
      const classification = classifyNetworkError(error);
      if (classification === 'timeout') {
        return new TimeoutError(
          `CachekitIO ${operation} timed out: ${this.sanitize(error.message)}`,
          {
            cause: error,
          }
        );
      }
      return new BackendError(
        `CachekitIO ${operation} failed: ${this.sanitize(error.message)}`,
        classification,
        { cause: error }
      );
    }
    return new BackendError(`CachekitIO ${operation} failed: Unknown error`);
  }

  /** Strip API key from error messages to prevent credential leakage (CWE-532). */
  private sanitize(text: string): string {
    return text.replaceAll(this.apiKey, '***');
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new BackendError('CachekitIO backend is closed');
    }
  }
}
