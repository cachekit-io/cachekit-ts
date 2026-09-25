import { BackendError } from '../errors.js';

export type ErrorClassification = 'transient' | 'permanent' | 'authentication' | 'timeout';

/**
 * Whether an error is worth retrying and counts as a backend-health signal
 * for the circuit breaker.
 *
 * A `BackendError` classified `permanent` or `authentication` is
 * request-specific — a malformed key, an oversized value, a bad API key.
 * The protocol (saas-api.md, Error Classification) says not to retry these,
 * and they say nothing about backend health: five malformed requests must not
 * open the breaker for every other key. Every other error — transient,
 * timeout, or anything that is not a `BackendError` — is retryable.
 */
export function isRetryable(error: unknown): boolean {
  return !(
    error instanceof BackendError &&
    (error.classification === 'permanent' || error.classification === 'authentication')
  );
}

export function classifyHttpError(status: number): ErrorClassification {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 408 || status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'permanent';
}

export function classifyNetworkError(error: Error): ErrorClassification {
  if (error.name === 'TimeoutError' || error.message.includes('timeout')) return 'timeout';
  return 'transient';
}

/**
 * Classify an error thrown by a Workers runtime API (KV, Cache API).
 *
 * Cloudflare embeds the upstream HTTP status in the message in a documented
 * position — "KV PUT failed: 429 Too Many Requests" — so the match is
 * anchored to `failed: <status>`; a 4xx/5xx-looking number anywhere else
 * (e.g. a byte count in a size-limit message) is NOT a status. Anything
 * without a recognizable status is treated as transient — retrying an
 * unknown edge failure is safe, retrying forever is the retry policy's
 * problem.
 */
export function classifyWorkersRuntimeError(error: Error): ErrorClassification {
  const status = /failed: ([45]\d{2})\b/.exec(error.message);
  return status ? classifyHttpError(Number(status[1])) : 'transient';
}
