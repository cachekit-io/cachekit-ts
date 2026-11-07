import { describe, it, expect } from 'vitest';
import { isThenable } from './thenable.js';

// What a library such as zone.js or Bluebird installs as the global Promise.
class ReplacedPromise<T> extends Promise<T> {}

describe('isThenable', () => {
  it.each([
    ['a native Promise', Promise.resolve(1), true],
    ['a Promise subclass', ReplacedPromise.resolve(1), true],
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
