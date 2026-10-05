import { Backend, CachekitIOBackendConfig, GetWithTtlResult } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';
import { DEFAULT_TTL_SECONDS } from '../constants.js';
import { getSessionHeaders } from './session.js';
import { buildMetricsHeaders } from './metrics-headers.js';
import { classifyHttpError, classifyNetworkError } from './error-classifier.js';
import { validateCachekitUrl } from './url-validator.js';
import { USER_AGENT } from './user-agent.js';

/**
 * Path segments a key may never encode to (protocol spec/saas-api.md
 * § Cache-Key Path Encoding, rule 2). `.` / `..` are dot segments that every
 * WHATWG parser — fetch's and the SaaS worker's own — removes before routing,
 * `%2E` forms included, so no encoding keeps them inside /v1/cache/ (CWE-22).
 * `health` / `ttl` / `lock` are live route tokens at that level. The SaaS
 * router matches all five exactly and case-sensitively, so only these
 * lowercase words are reserved: `a:..`, `..a`, `HEALTH`, `ttls` transmit.
 */
const RESERVED_SEGMENTS = new Set(['.', '..', 'health', 'ttl', 'lock']);

/**
 * Percent-encode a cache key as a single URL path segment, or throw
 * `ConfigurationError` if it is empty, a reserved segment (RESERVED_SEGMENTS)
 * or malformed UTF-16. Every other key is exactly `encodeURIComponent(key)`:
 * decode-equivalent to cachekit-py and cachekit-rs, which additionally
 * encode `! * ' ( )` (spec rule 4; fixture `encoded_alternates`).
 */
export function encodeKey(key: string): string {
  // An empty key encodes to an empty segment, so /v1/cache/{key} becomes /v1/cache/
  // and /v1/cache/{key}/ttl becomes /v1/cache//ttl, neither of which addresses a
  // stored entry (spec rule 2). RESERVED_SEGMENTS never sees it; reject it up front.
  if (key === '') {
    throw new ConfigurationError(
      'Cache key must not be empty: it encodes to an empty path segment, so /v1/cache/{key} and ' +
        '/v1/cache/{key}/ttl address no stored entry (CWE-22). Use a non-empty, namespaced key.'
    );
  }
  let encoded: string;
  try {
    encoded = encodeURIComponent(key);
  } catch (error) {
    // Lone surrogate: encodeURIComponent throws a raw URIError. Every SDK error is a CachekitError.
    throw new ConfigurationError('Cache key is not well-formed UTF-16 (lone surrogate)', {
      cause: error,
    });
  }
  if (RESERVED_SEGMENTS.has(encoded)) {
    throw new ConfigurationError(
      `Cache key "${key}" is a reserved path segment (one of ${[...RESERVED_SEGMENTS].join(' ')}) ` +
        `and cannot be addressed at /v1/cache/{key} (CWE-22). Use a namespaced key instead.`
    );
  }
  return encoded;
}

/**
 * Read the server's freshness headers off a `GET 200` (protocol spec/saas-api.md
 * § Remaining Freshness). Fails closed:
 * - `X-CacheKit-Freshness` absent means fresh (pre-SWR servers omit it); any
 *   value other than exactly `fresh` is stale. Repeated copies arrive
 *   comma-joined from `Headers.get`, so `fresh, fresh` is stale too. That is
 *   deliberately stricter than cachekit-rs, which accepts it: the spec
 *   licenses a backfill only for exactly `fresh`, so do not relax this.
 * - `X-CacheKit-Fresh-For` must be 1–7 ASCII digits and at most 2,592,000;
 *   anything else is `0`. Length is checked first and the digits are summed by
 *   hand: `Number()` and `parseInt` accept `+5`, `0x10`, `1e3` and `1_0`-style
 *   shapes the spec maps to `0`.
 *
 * Exported for tests; not part of the public API.
 */
export function freshnessFromHeaders(
  headers: Headers
): Pick<GetWithTtlResult, 'isStale' | 'freshFor'> {
  const label = headers.get('X-CacheKit-Freshness');
  const raw = headers.get('X-CacheKit-Fresh-For');
  return {
    isStale: label !== null && label !== 'fresh',
    ...(raw !== null && { freshFor: parseFreshFor(raw) }),
  };
}

function parseFreshFor(raw: string): number {
  if (raw.length < 1 || raw.length > 7) return 0;
  let seconds = 0;
  for (let i = 0; i < raw.length; i++) {
    const digit = raw.charCodeAt(i) - 48; // '0'
    if (digit < 0 || digit > 9) return 0;
    seconds = seconds * 10 + digit;
  }
  return seconds > MAX_TTL_SECONDS ? 0 : seconds;
}

const DEFAULT_API_URL = 'https://api.cachekit.io';
const DEFAULT_TIMEOUT_MS = 5_000;

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
    return (await this.getWithTtl(key))?.value ?? null;
  }

  /**
   * Backend.getWithTtl capability: the same single GET as `get`, plus the
   * server's freshness headers, so CacheImpl can refuse or bound the L1
   * backfill (protocol spec/saas-api.md § Remaining Freshness). `ttlSeconds`
   * stays `null`: a GET carries no remaining-eviction signal.
   */
  async getWithTtl(key: string): Promise<GetWithTtlResult | null> {
    this.ensureNotClosed();
    const url = this.cacheUrl(key);

    try {
      const response = await this.request('GET', url);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw await this.httpError('get', response);
      }

      return {
        value: new Uint8Array(await response.arrayBuffer()),
        ttlSeconds: null,
        ...freshnessFromHeaders(response.headers),
      };
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

  /** Backend.validateKey capability — rejects any key `encodeKey` refuses (empty,
   * reserved segment, malformed UTF-16) synchronously, before the reliability
   * executor can swallow it. */
  validateKey(key: string): void {
    encodeKey(key);
  }

  async set(key: string, value: Uint8Array, ttl?: number): Promise<void> {
    this.ensureNotClosed();

    const effectiveTtl = validateTtl(ttl ?? this.defaultTtl);
    const headers: Record<string, string> = { 'X-CacheKit-TTL': String(effectiveTtl) };
    const url = this.cacheUrl(key);

    try {
      const response = await this.request('PUT', url, {
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

  /** @returns true on every successful delete, whether or not the key
   * existed: the server does not report existence on DELETE. */
  async delete(key: string): Promise<boolean> {
    this.ensureNotClosed();
    const url = this.cacheUrl(key);

    try {
      const response = await this.request('DELETE', url);

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
    const url = this.cacheUrl(key);

    try {
      const response = await this.request('HEAD', url);

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

  /** Call before the network `try`: encodeKey's ConfigurationError must reach
   * the caller as-is, not wrapped by the catch as a BackendError. */
  private cacheUrl(key: string): string {
    return `${this.apiUrl}/v1/cache/${encodeKey(key)}`;
  }

  private async request(
    method: string,
    url: string,
    opts?: { body?: Uint8Array; headers?: Record<string, string> }
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
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
      // The API never redirects, and this request carries credentials, so it
      // goes only to the configured URL: 'manual' returns a 3xx as the
      // response, which every caller treats as an error (it is not 2xx).
      // Not 'error': Node raises that as a network failure, which is retried.
      redirect: 'manual',
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
      throw new BackendError('CachekitIO backend is closed', 'permanent');
    }
  }
}
