export type ErrorClassification = 'transient' | 'permanent' | 'authentication' | 'timeout';

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
 * Cloudflare embeds the upstream HTTP status in the message (documented
 * format, e.g. "KV PUT failed: 429 Too Many Requests"); anything without a
 * recognizable status is treated as transient — retrying an unknown edge
 * failure is safe, retrying forever is the retry policy's problem.
 */
export function classifyWorkersRuntimeError(error: Error): ErrorClassification {
  const status = /\b([45]\d{2})\b/.exec(error.message);
  return status ? classifyHttpError(Number(status[1])) : 'transient';
}
