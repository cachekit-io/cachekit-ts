/**
 * CacheKit constants and default values.
 *
 * All magic numbers extracted into named constants for maintainability.
 * Constants are organized by functional area.
 */

// ============================================================================
// TTL (Time-To-Live) Constants
// ============================================================================

/** Default cache TTL in seconds (1 hour) */
export const DEFAULT_TTL_SECONDS = 3600;

// ============================================================================
// L1 Cache Constants
// ============================================================================

/** Default maximum entries in L1 cache */
export const DEFAULT_L1_MAX_ENTRIES = 1000;

/** Default maximum memory for L1 cache in bytes (50MB) */
export const DEFAULT_L1_MAX_MEMORY = 50 * 1024 * 1024;

/** Default SWR threshold ratio (50% of TTL) */
export const DEFAULT_L1_SWR_THRESHOLD_RATIO = 0.5;

/** Default maximum concurrent SWR refreshes */
export const DEFAULT_L1_MAX_CONCURRENT_REFRESHES = 10;

/** Default estimated size for uncalculable values (bytes) */
export const DEFAULT_L1_FALLBACK_SIZE = 100;

// ============================================================================
// Serialization Constants
// ============================================================================

/** Maximum encoded size in bytes (1MB) */
export const DEFAULT_MAX_ENCODED_SIZE = 1024 * 1024;

/** Maximum decoded size in bytes (10MB) */
export const DEFAULT_MAX_DECODED_SIZE = 10 * 1024 * 1024;

/** Maximum object nesting depth */
export const DEFAULT_MAX_DEPTH = 100;

/** Maximum collection size for Maps, Sets, Arrays, Objects */
export const DEFAULT_MAX_COLLECTION_SIZE = 10000;

/** Maximum size for key generation (64KB) */
export const KEY_GEN_MAX_SIZE = 64 * 1024;

/** Maximum depth for key generation */
export const KEY_GEN_MAX_DEPTH = 50;

/** Expected hash length for cache keys (hex chars) */
export const CACHE_KEY_HASH_LENGTH = 64;

// ============================================================================
// Retry Policy Constants
// ============================================================================

/** Default maximum retry attempts */
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

/** Default retry base delay in milliseconds */
export const DEFAULT_RETRY_BASE_DELAY = 100;

/** Default retry maximum delay in milliseconds (5 seconds) */
export const DEFAULT_RETRY_MAX_DELAY = 5000;

/** Jitter range minimum multiplier (50% of delay) */
export const RETRY_JITTER_MIN = 0.5;

/** Jitter range maximum multiplier (150% of delay) */
export const RETRY_JITTER_MAX = 1.5;

// ============================================================================
// Circuit Breaker Constants
// ============================================================================

/** Default failure threshold before opening circuit */
export const DEFAULT_CB_FAILURE_THRESHOLD = 10;

/** Default success threshold to close circuit from half-open */
export const DEFAULT_CB_SUCCESS_THRESHOLD = 2;

/** Default circuit breaker timeout in milliseconds (5 seconds) */
export const DEFAULT_CB_TIMEOUT = 5000;

/** Default max calls allowed in half-open state */
export const DEFAULT_CB_HALF_OPEN_MAX_CALLS = 3;

/** Default rolling window for failure counting in milliseconds (60 seconds) */
export const DEFAULT_CB_ROLLING_WINDOW = 60000;

// ============================================================================
// Redis Backend Constants
// ============================================================================

/** Default Redis connect timeout in milliseconds (10 seconds) */
export const DEFAULT_REDIS_CONNECT_TIMEOUT = 10000;

/** Default Redis command timeout in milliseconds (5 seconds) */
export const DEFAULT_REDIS_COMMAND_TIMEOUT = 5000;

/** Default Redis max retries per request */
export const DEFAULT_REDIS_MAX_RETRIES = 3;

/** Redis retry base delay in milliseconds */
export const REDIS_RETRY_BASE_DELAY = 100;

/** Redis retry maximum delay in milliseconds (30 seconds) */
export const REDIS_RETRY_MAX_DELAY = 30000;

// ============================================================================
// Encryption Constants
// ============================================================================

/** AAD version byte (v0x03 includes cache_key binding) */
export const AAD_VERSION = 0x03;

/** Minimum master key length in bytes */
export const MIN_MASTER_KEY_BYTES = 32;

/** Minimum master key length in hex characters */
export const MIN_MASTER_KEY_HEX_LENGTH = 64;

// ============================================================================
// Stampede / Single-Flight Constants
// ============================================================================

/** Default distributed lock lease in milliseconds (matches cachekit-py's lock_timeout=30s) */
export const DEFAULT_LOCK_TIMEOUT_MS = 30000;

/** Default wait for a contested lock holder to fill the cache (matches cachekit-py's blocking_timeout=5s) */
export const DEFAULT_LOCK_WAIT_MS = 5000;

/** Default lock retry interval while contested, in milliseconds */
export const DEFAULT_LOCK_POLL_MS = 100;

// ============================================================================
// SWR (Stale-While-Revalidate) Constants
// ============================================================================

/** SWR jitter minimum (90% of threshold) */
export const SWR_JITTER_MIN = 0.9;

/** SWR jitter range (±10% = 0.2 total range) */
export const SWR_JITTER_RANGE = 0.2;
