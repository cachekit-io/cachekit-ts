import { describe, it, expect } from 'vitest';
import { isThenable } from './thenable.js';

class SubPromise<T> extends Promise<T> {}

// An `instanceof Promise` check gets every row right but the plain thenable. The case
// that made the cache test for a thenable, the engine's own Promise checked
// against a replaced global Promise, is held by the replaced-Promise tests in
// cache.encryption-l1.test.ts.
describe('isThenable', () => {
  it.each([
    ['a native Promise', Promise.resolve(1), true],
    ['a Promise subclass', SubPromise.resolve(1), true],
    ['a plain thenable', { then: () => {} }, true],
    ['an object whose then is not a function', { then: 1 }, false],
    ['a Uint8Array', new Uint8Array([1]), false],
    ['a { value } wrapper', { value: 1 }, false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('%s: %s', (_, value, expected) => {
    expect(isThenable(value)).toBe(expected);
  });
});
