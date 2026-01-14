import { describe, it, expect } from 'vitest';
import { generateKey, generateParamsHash, extractNamespace } from './key-generator.js';

describe('generateKey', () => {
  it('generates consistent keys for same input', () => {
    const key1 = generateKey('test:fn', [1, 2, 3]);
    const key2 = generateKey('test:fn', [1, 2, 3]);
    expect(key1).toBe(key2);
  });

  it('generates different keys for different inputs', () => {
    const key1 = generateKey('test:fn', [1, 2, 3]);
    const key2 = generateKey('test:fn', [1, 2, 4]);
    expect(key1).not.toBe(key2);
  });

  it('includes namespace in key', () => {
    const key = generateKey('my-service:myFunction', []);
    expect(key.startsWith('my-service:myFunction:')).toBe(true);
  });

  it('produces 64-char hex hash', () => {
    const key = generateKey('test', [1]);
    const hash = key.split(':').pop()!;
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('handles complex nested arguments', () => {
    const args = [{ nested: { deep: { value: [1, 2, 3] } } }];
    const key = generateKey('test', args);
    expect(key).toBeTruthy();
  });

  it('is deterministic with object key order', () => {
    const key1 = generateKey('test', [{ b: 2, a: 1 }]);
    const key2 = generateKey('test', [{ a: 1, b: 2 }]);
    expect(key1).toBe(key2); // Object keys are sorted
  });
});

describe('generateParamsHash', () => {
  it('returns 64-char hex string', () => {
    const hash = generateParamsHash([1, 2, 3]);
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('matches hash portion of generateKey', () => {
    const args = [1, 2, 3];
    const fullKey = generateKey('test', args);
    const paramsHash = generateParamsHash(args);
    expect(fullKey.endsWith(paramsHash)).toBe(true);
  });
});

describe('extractNamespace', () => {
  it('extracts namespace from valid key', () => {
    const hash = 'a'.repeat(64);
    const key = `my-service:getUser:${hash}`;
    expect(extractNamespace(key)).toBe('my-service:getUser');
  });

  it('handles namespaces with colons', () => {
    const hash = 'b'.repeat(64);
    const key = `a:b:c:${hash}`;
    expect(extractNamespace(key)).toBe('a:b:c');
  });

  it('returns original key if no hash', () => {
    expect(extractNamespace('no-hash')).toBe('no-hash');
  });
});
