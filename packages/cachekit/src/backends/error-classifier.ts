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
