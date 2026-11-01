import { Backend, CachekitIOBackendConfig, GetWithTtlResult } from './types.js';
import { BackendError, ConfigurationError, TimeoutError } from '../errors.js';
import { DEFAULT_TTL_SECONDS } from '../constants.js';
import { getSessionHeaders } from './session.js';
import { buildMetricsHeaders } from './metrics-headers.js';
import { L1_LATENCY_ONE_IN, L1LatencyReport, resolveTelemetry } from './telemetry.js';
import { oneAttemptDispatcher } from './one-attempt-dispatcher.js';
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
 * Validate a stale-grace window per the protocol's Stale-While-Revalidate
 * validation rules (protocol/spec/saas-api.md): negative, non-finite and
 * values over 2,591,999 are rejected before any arithmetic; fractions are
 * ceiled (API-54); the window shares the 30-day cap with `wireTtl`, the
 * already-validated TTL. Returns the whole seconds to send; `0` sends nothing.
 */
export function validateStaleTtl(staleTtl: number, wireTtl: number): number {
  if (!Number.isFinite(staleTtl) || staleTtl < 0 || staleTtl > MAX_TTL_SECONDS - 1) {
    throw new ConfigurationError(
      `staleTtl must be at least 0 and at most ${MAX_TTL_SECONDS - 1} seconds, got ${staleTtl}`
    );
  }
  const wire = Math.ceil(staleTtl);
  if (wireTtl + wire > MAX_TTL_SECONDS) {
    throw new ConfigurationError(
      `ttl + staleTtl must be at most ${MAX_TTL_SECONDS} seconds (30 days), got ${wireTtl} + ${wire}`
    );
  }
  return wire;
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
  /** The telemetry switch, resolved once at construction (API-95). */
  private readonly telemetry: boolean;
  /**
   * This backend's one L1 hit-latency accumulator (API-83 to API-86); absent
   * while telemetry is off, so nothing is timed into it. See Backend.l1Latency.
   * @internal
   */
  readonly l1Latency?: L1LatencyReport;
  private closed = false;

  constructor(config: CachekitIOBackendConfig) {
    if (!config.apiKey) {
      throw new ConfigurationError('CachekitIO backend requires an apiKey');
    }

    this.apiUrl = validateCachekitUrl(config.apiUrl ?? DEFAULT_API_URL, config.allowCustomHost);
    this.apiKey = config.apiKey;
    this.defaultTtl = validateTtl(config.defaultTtl ?? DEFAULT_TTL_SECONDS);
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
    this.metricsProvider = config.metricsProvider;
    this.telemetry = resolveTelemetry(config.telemetry);
    if (this.telemetry) this.l1Latency = new L1LatencyReport(L1_LATENCY_ONE_IN);
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
    await this.put(key, value, { 'X-CacheKit-TTL': String(effectiveTtl) });
  }

  /** Backend.setWithStaleTtl capability: the same PUT, also carrying
   * `X-CacheKit-Stale-TTL`. Validated before any I/O; a `0` window sends no
   * header, which the server reads the same way. */
  async setWithStaleTtl(
    key: string,
    value: Uint8Array,
    ttl: number,
    staleTtl: number
  ): Promise<void> {
    this.ensureNotClosed();
    const effectiveTtl = validateTtl(ttl);
    const wireStaleTtl = validateStaleTtl(staleTtl, effectiveTtl);
    await this.put(key, value, {
      'X-CacheKit-TTL': String(effectiveTtl),
      ...(wireStaleTtl > 0 && { 'X-CacheKit-Stale-TTL': String(wireStaleTtl) }),
    });
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
      // No latency report: the server does not record health checks (API-84).
      const response = await this.request('GET', `${this.apiUrl}/v1/cache/health`, {
        latencyReport: false,
      });
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

  /** PUT the value with `headers`. Validate before calling: the catch
   * below would wrap a ConfigurationError as a BackendError. */
  private async put(
    key: string,
    value: Uint8Array,
    headers: Record<string, string>
  ): Promise<void> {
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

  /** Call before the network `try`: encodeKey's ConfigurationError must reach
   * the caller as-is, not wrapped by the catch as a BackendError. */
  private cacheUrl(key: string): string {
    return `${this.apiUrl}/v1/cache/${encodeKey(key)}`;
  }

  /**
   * One attempt. With telemetry off it carries no optional metrics header
   * (API-96). A latency report is taken here, on every call, so each attempt
   * the cache's retries make takes its own: the one it takes is consumed
   * whatever the outcome, and never re-sent (API-86), not even by the resend
   * fetch makes on its own after a 421 (see takeLatencyReport). The headers
   * go only to this backend's configured API, and a redirect is never
   * followed (API-77).
   */
  private async request(
    method: string,
    url: string,
    opts?: { body?: Uint8Array; headers?: Record<string, string>; latencyReport?: false }
  ): Promise<Response> {
    const report = opts?.latencyReport === false ? undefined : this.takeLatencyReport();
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${this.apiKey}`,
      ...(this.telemetry && getSessionHeaders()),
      ...buildMetricsHeaders(this.metricsProvider, this.telemetry),
      ...report?.headers,
      ...opts?.headers,
    };
    if (opts?.body) {
      headers['Content-Type'] = opts.headers?.['Content-Type'] ?? 'application/octet-stream';
    }

    const init: RequestInit = {
      method,
      headers,
      body: opts?.body,
      // The API never redirects, and this request carries credentials, so it
      // goes only to the configured URL: 'manual' returns a 3xx as the
      // response, which every caller treats as an error (it is not 2xx).
      // Not 'error': Node raises that as a network failure, which is retried.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeout),
    };
    // Typed loosely: the dispatcher implements the one method of undici's
    // Dispatcher that fetch calls, and the package does not depend on undici.
    if (report) (init as { dispatcher?: object }).dispatcher = report.dispatcher;
    return fetch(url, init);
  }

  /**
   * This backend's latency report for one request, with the fetch dispatcher
   * that strips it from any resend of that request (one-attempt-dispatcher.ts).
   * Undefined, leaving the report in place, while there is nothing to report
   * (API-85) or no such dispatcher: on any runtime but Node, which alone
   * times L1 hits, and on Node while its global dispatcher is anything but
   * undici's own Agent, which might resend the request.
   */
  private takeLatencyReport(): { headers: Record<string, string>; dispatcher: object } | undefined {
    const report = this.l1Latency;
    if (report === undefined || report.empty) return undefined;
    const dispatcher = oneAttemptDispatcher();
    if (dispatcher === undefined) return undefined;
    return { headers: report.take()!, dispatcher };
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
