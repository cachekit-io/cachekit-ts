import { encode, decode } from '@msgpack/msgpack';
import type { InvalidationLevel, InvalidationEvent } from '../l1/types.js';

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
 */
export function deserializeEvent(data: Uint8Array): InvalidationEvent {
  const compact = decode(data) as CompactEvent;

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
