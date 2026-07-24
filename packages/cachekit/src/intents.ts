/**
 * Intent-based cache factory functions (Node entrypoint).
 *
 * Each intent pre-configures the full stack (backend, reliability, encryption)
 * so users declare WHAT they want, not HOW to wire it. The intent logic is
 * shared with the Workers entrypoint via intents-core.ts.
 *
 * @example
 * ```typescript
 * // Speed-first, no protection
 * const cache = createCache.minimal({ url: 'redis://localhost:6379', ttl: 300 });
 *
 * // Reliability-first with circuit breaker + retry
 * const cache = createCache.production({ url: 'redis://localhost:6379', ttl: 600 });
 *
 * // Zero-knowledge encryption
 * const cache = createCache.secure({ url: 'redis://localhost:6379', masterKey: '...' });
 *
 * // SaaS backend (cachekit.io)
 * const cache = createCache.io({ apiKey: 'ck_live_...', ttl: 3600 });
 * ```
 */

import { createCache as _createCache } from './cache.js';
import { buildIntents } from './intents-core.js';

export type {
  CreateCacheFn,
  MinimalOptions,
  ProductionOptions,
  SecureOptions,
  IOOptions,
} from './intents-core.js';

/** createCache with intent-based factory methods attached. */
export const createCache = buildIntents(_createCache);
