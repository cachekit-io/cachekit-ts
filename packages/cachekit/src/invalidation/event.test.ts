import { describe, it, expect } from 'vitest';
import { encode, DecodeError } from '@msgpack/msgpack';
import { serializeEvent, deserializeEvent, createInvalidationEvent } from './event';
import { SerializationError } from '../errors';

describe('InvalidationEvent serialization', () => {
  it('round-trips global event', () => {
    const event = createInvalidationEvent('global', 'instance-1');
    const serialized = serializeEvent(event);
    const deserialized = deserializeEvent(serialized);

    expect(deserialized.level).toBe('global');
    expect(deserialized.sourceInstance).toBe('instance-1');
    expect(deserialized.timestamp).toBe(event.timestamp);
  });

  it('round-trips namespace event', () => {
    const event = createInvalidationEvent('namespace', 'instance-2', { namespace: 'users' });
    const serialized = serializeEvent(event);
    const deserialized = deserializeEvent(serialized);

    expect(deserialized.level).toBe('namespace');
    expect(deserialized.namespace).toBe('users');
  });

  it('round-trips params event', () => {
    const event = createInvalidationEvent('params', 'instance-3', {
      namespace: 'users:getUser',
      paramsHash: 'abc123',
    });
    const serialized = serializeEvent(event);
    const deserialized = deserializeEvent(serialized);

    expect(deserialized.level).toBe('params');
    expect(deserialized.namespace).toBe('users:getUser');
    expect(deserialized.paramsHash).toBe('abc123');
  });

  it('uses compact keys for small payload', () => {
    const event = createInvalidationEvent('global', 'x');
    const serialized = serializeEvent(event);

    // Compact keys should keep payload small
    expect(serialized.length).toBeLessThan(50);
  });

  it('rejects a forged giant collection header before preallocating (LAB-281 DoS)', () => {
    // array32 claiming 2^32-1 elements in 5 bytes — must fail on the length
    // cap, not attempt new Array(4294967295). Pub/sub bytes are untrusted.
    expect(() => deserializeEvent(Uint8Array.of(0xdd, 0xff, 0xff, 0xff, 0xff))).toThrow();
    // map16 claiming 65535 entries.
    expect(() => deserializeEvent(Uint8Array.of(0xde, 0xff, 0xff))).toThrow();
  });

  it('rejects an oversized event at the PUBLISHER, not just the subscriber (LAB-2487)', () => {
    // If only deserializeEvent enforced the cap, an oversized event would be
    // silently rejected by every subscriber — invalidation lost, stale L1
    // served — with no signal to the publisher. serializeEvent must throw so
    // the caller can act.
    const oversized = createInvalidationEvent('namespace', 'instance-1', {
      namespace: 'n'.repeat(5000),
    });
    expect(() => serializeEvent(oversized)).toThrow(/exceeds max/);

    // Publish/subscribe symmetry: anything serializeEvent accepts,
    // deserializeEvent must accept back (no event a publisher can emit is
    // droppable on read for size).
    const atSanityEdge = createInvalidationEvent('params', 'instance-1', {
      namespace: 'n'.repeat(1000),
      paramsHash: 'f'.repeat(64),
    });
    expect(deserializeEvent(serializeEvent(atSanityEdge)).namespace).toBe('n'.repeat(1000));
  });

  it('wraps a decoder failure in SerializationError with cause (LAB-3477)', () => {
    // fixext1 with an unrecognised timestamp payload: passes the size and depth
    // checks (3 bytes, no collections) and fails INSIDE @msgpack's decoder.
    const run = (): unknown => deserializeEvent(Uint8Array.of(0xd4, 0xff, 0x00));
    expect(run).toThrow(SerializationError);
    expect(run).toThrow(/Failed to decode invalidation event/);
    let cause: unknown;
    try {
      run();
    } catch (err) {
      cause = (err as SerializationError).cause;
    }
    expect(cause).toBeInstanceOf(DecodeError);
  });

  it('rejects a well-formed payload that is not a map (LAB-3477)', () => {
    for (const notAMap of [[], 'global', null]) {
      const run = (): unknown => deserializeEvent(encode(notAMap));
      expect(run).toThrow(SerializationError);
      expect(run).toThrow(/^Invalidation event payload is not a map/);
    }
  });

  it('rejects a map missing or mistyping a required key (LAB-3477)', () => {
    const valid = { l: 'global', ts: 1, src: 'i' };
    const bad: unknown[] = [
      { ts: 1, src: 'i' },
      { l: 'global', src: 'i' },
      { l: 'global', ts: 1 },
      { ...valid, l: 7 },
      { ...valid, l: 'bogus' },
      { ...valid, ts: 'now' },
      { ...valid, src: null },
      { ...valid, ns: 1 },
      { ...valid, ph: [] },
    ];
    for (const payload of bad) {
      const run = (): unknown => deserializeEvent(encode(payload));
      expect(run).toThrow(SerializationError);
      expect(run).toThrow(/^Invalidation event payload is not a map/);
    }
    expect(deserializeEvent(encode(valid))).toStrictEqual({
      level: 'global',
      namespace: undefined,
      paramsHash: undefined,
      timestamp: 1,
      sourceInstance: 'i',
    });
  });

  it('accepts nil-encoded optionals and normalizes them to undefined (LAB-4336)', () => {
    // A struct/dict encoder emits nil for an unset field instead of omitting
    // the key — msgpack.packb({'ns': None}) in Python does. Rejecting this
    // payload would drop a whole-cache invalidation and leave L1 stale until
    // TTL — RedisInvalidationChannel only logs the deserialize failure, so the
    // publisher never learns its invalidation went nowhere.
    // Level 'global' on purpose — invalidateAll() reads neither optional, so
    // this is the payload where acceptance actually prevents staleness.
    expect(
      deserializeEvent(encode({ l: 'global', ts: 1, src: 'i', ns: null, ph: null }))
    ).toStrictEqual({
      level: 'global',
      namespace: undefined,
      paramsHash: undefined,
      timestamp: 1,
      sourceInstance: 'i',
    });
  });
});
