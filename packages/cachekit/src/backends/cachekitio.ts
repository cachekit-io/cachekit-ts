import { Backend, CachekitIOBackendConfig } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';
import { DEFAULT_TTL_SECONDS } from '../constants.js';
import { getSessionHeaders } from './session.js';
import { buildMetricsHeaders } from './metrics-headers.js';
import { classifyHttpError, classifyNetworkError } from './error-classifier.js';
import { validateCachekitUrl } from './url-validator.js';

/**
 * Percent-encode a cache key for use as a single URL path segment.
 *
 * `encodeURIComponent` leaves `.` untouched (RFC-3986 unreserved), so a key
 * of exactly `.` or `..` triggers dot-segment removal in the HTTP client's
 * URL parser — the request escapes /v1/cache/ before it hits the wire
 * (CWE-22).
 *
 * Python's fix encodes dots to `%2E`, which works because Python HTTP
 * clients (httpx/requests) use RFC-3986 where `%2E` is opaque. In JS,
 * `fetch`/undici parse URLs per the WHATWG URL Standard, which treats `%2E`
 * identically to `.` for dot-segment removal — there is no percent-encoding
 * of `.` that survives WHATWG normalisation in a path segment. We reject
 * these keys instead: fail-fast with a clear error rather than silently
 * sending an authenticated request to the wrong path.
 */
export function encodeKey(key: string): string {
  const encoded = encodeURIComponent(key);
  if (encoded === '.' || encoded === '..') {
    throw new ConfigurationError(
      `Cache key "${key}" is a bare dot-segment and cannot be used as a URL path segment — ` +
        `the WHATWG URL parser (used by fetch) would collapse it, sending the request outside ` +
        `/v1/cache/ (CWE-22). Use a namespaced key instead.`
    );
  }
  return encoded;
}

const DEFAULT_API_URL = 'https://api.cachekit.io';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Protocol TTL ceiling: 30 days in seconds (protocol/spec/saas-api.md, TTL Validation Rules). */
const MAX_TTL_SECONDS = 2_592_000;

/**
 * Validate a TTL per the protocol's normative TTL Validation Rules
 * (protocol/spec/saas-api.md): zero, negative, non-finite, and values over
 * 30 days are rejected; sub-second/fractional durations are ceiled to whole
 * seconds (never truncated to 0). Exported for the TTL decorator's
 * refreshTTL, which sends the same value in the PATCH body.
 */
export function validateTtl(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new ConfigurationError(
      `TTL must be greater than 0 and at most ${MAX_TTL_SECONDS} seconds (30 days), got ${ttl}`
    );
  }
  return Math.ceil(ttl);
}

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
  /** CachekitIO stores keys verbatim — no wire-key transform (keys travel
   * URL-encoded but the server sees the exact key). See Backend.keyPrefix. */
  readonly keyPrefix?: string;
  /** Verbatim keys — no transform; left unset. See Backend.transformsKeys. */
  readonly transformsKeys?: boolean;
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
    this.defaultTtl = validateTtl(config.defaultTtl ?? DEFAULT_TTL_SECONDS);
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

  /** Backend.validateTtl capability — lets CacheImpl reject an invalid TTL
   * synchronously, before the reliability executor can swallow it. */
  validateTtl(ttl: number): void {
    validateTtl(ttl);
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();

    const effectiveTtl = validateTtl(ttl ?? this.defaultTtl);
    const headers: Record<string, string> = { 'X-CacheKit-TTL': String(effectiveTtl) };

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
  async requestJson(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<Response> {
    return this.request(method, url, {
      body: body ? new TextEncoder().encode(JSON.stringify(body)) : undefined,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    });
  }

  // ── Internal ──────────────────────────────────────────────

  private cacheUrl(key: string): string {
    return `${this.apiUrl}/v1/cache/${encodeKey(key)}`;
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
