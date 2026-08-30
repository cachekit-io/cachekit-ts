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
 * Serialize an InvalidationEvent to bytes for transmission.
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

  return encode(compact);
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
 * @throws {SerializationError} if input exceeds the decode size cap
 */
export function deserializeEvent(data: Uint8Array): InvalidationEvent {
  if (data.length > DEFAULT_MAX_INVALIDATION_EVENT_SIZE) {
    throw new SerializationError(
      `Invalidation event size ${data.length} exceeds max ${DEFAULT_MAX_INVALIDATION_EVENT_SIZE}`
    );
  }
  assertDecodeDepth(data, MAX_INVALIDATION_EVENT_DEPTH);
  const compact = decode(
    data,
    boundedDecodeOptions(DEFAULT_MAX_COLLECTION_SIZE, DEFAULT_MAX_INVALIDATION_EVENT_SIZE)
  ) as CompactEvent;

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
