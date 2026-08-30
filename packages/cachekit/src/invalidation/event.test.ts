import { describe, it, expect } from 'vitest';
import { serializeEvent, deserializeEvent, createInvalidationEvent } from './event';

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
});
