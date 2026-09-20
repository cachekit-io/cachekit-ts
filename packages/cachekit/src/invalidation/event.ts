import { encode, decode } from '@msgpack/msgpack';
import type { InvalidationLevel, InvalidationEvent } from '../l1/types.js';
import { assertDecodeDepth, boundedDecodeOptions } from '../serialization/serializer.js';
import {
  DEFAULT_MAX_COLLECTION_SIZE,
  DEFAULT_MAX_INVALIDATION_EVENT_SIZE,
  MAX_INVALIDATION_EVENT_DEPTH,
} from '../constants.js';
import { SerializationError } from '../errors.js';

/**
 * Compact MessagePack keys for wire format.
 */
const COMPACT_KEYS = {
  level: 'l',
  namespace: 'ns',
  paramsHash: 'ph',
  timestamp: 'ts',
  sourceInstance: 'src',
} as const;

interface CompactEvent {
  [COMPACT_KEYS.level]: string;
  [COMPACT_KEYS.namespace]?: string;
  [COMPACT_KEYS.paramsHash]?: string;
  [COMPACT_KEYS.timestamp]: number;
  [COMPACT_KEYS.sourceInstance]: string;
}

/**
 * Shape check for a decoded pub/sub payload. Anything the decoder accepts is
 * still untrusted: a well-formed array, scalar, or map missing `l`/`ts`/`src`
 * must not become an event assembled from `undefined` fields.
 */
function isCompactEvent(value: unknown): value is CompactEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.l === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.src === 'string' &&
    (v.ns === undefined || typeof v.ns === 'string') &&
    (v.ph === undefined || typeof v.ph === 'string')
  );
}

/**
 * Serialize an InvalidationEvent to bytes for transmission.
 *
 * Enforces the same size cap as {@link deserializeEvent}: an event over the
 * cap would be rejected by every subscriber — the invalidation silently lost
 * and stale L1 entries kept — so it fails HERE, at the publisher, where the
 * caller (whose namespace makes the event oversized) can act on the error.
 *
 * @throws {SerializationError} if the encoded event exceeds the event size cap
 */
export function serializeEvent(event: InvalidationEvent): Uint8Array {
  const compact: CompactEvent = {
    l: event.level,
    ts: event.timestamp,
    src: event.sourceInstance,
  };

  if (event.namespace) {
    compact.ns = event.namespace;
  }
  if (event.paramsHash) {
    compact.ph = event.paramsHash;
  }

  const bytes = encode(compact);
  if (bytes.length > DEFAULT_MAX_INVALIDATION_EVENT_SIZE) {
    throw new SerializationError(
      `Invalidation event size ${bytes.length} exceeds max ${DEFAULT_MAX_INVALIDATION_EVENT_SIZE}`
    );
  }
  return bytes;
}

/**
 * Deserialize bytes to an InvalidationEvent.
 *
 * Pub/sub bytes are untrusted (same backend-write attacker as cache reads),
 * so decoding is bounded — full rationale: boundedDecodeOptions in
 * serializer.ts. An event is a fixed flat map of scalars, so this path is
 * held to a much tighter size + depth cap than a general cache value
 * (least privilege: a forged event cannot ride the 10MB value ceiling).
 *
 * @throws {SerializationError} if input exceeds the decode size or depth cap,
 *   is not well-formed MessagePack (the decoder failure is attached as
 *   `cause`), or decodes to anything other than a map carrying string `l`,
 *   number `ts` and string `src`
 */
export function deserializeEvent(data: Uint8Array): InvalidationEvent {
  if (data.length > DEFAULT_MAX_INVALIDATION_EVENT_SIZE) {
    throw new SerializationError(
      `Invalidation event size ${data.length} exceeds max ${DEFAULT_MAX_INVALIDATION_EVENT_SIZE}`
    );
  }
  assertDecodeDepth(data, MAX_INVALIDATION_EVENT_DEPTH);
  let compact: unknown;
  try {
    compact = decode(
      data,
      boundedDecodeOptions(DEFAULT_MAX_COLLECTION_SIZE, DEFAULT_MAX_INVALIDATION_EVENT_SIZE)
    );
  } catch (error) {
    throw new SerializationError(
      `Failed to decode invalidation event: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
  if (!isCompactEvent(compact)) {
    throw new SerializationError(
      'Invalidation event payload is not a map with required keys l (string), ts (number), src (string)'
    );
  }

  return {
    level: compact.l as InvalidationLevel,
    namespace: compact.ns,
    paramsHash: compact.ph,
    timestamp: compact.ts,
    sourceInstance: compact.src,
  };
}

/**
 * Create an InvalidationEvent.
 */
export function createInvalidationEvent(
  level: InvalidationLevel,
  sourceInstance: string,
  options?: { namespace?: string; paramsHash?: string }
): InvalidationEvent {
  return {
    level,
    namespace: options?.namespace,
    paramsHash: options?.paramsHash,
    timestamp: Date.now(),
    sourceInstance,
  };
}
