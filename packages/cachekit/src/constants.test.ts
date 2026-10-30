/**
 * The encryption size limits live in three places: both native bindings'
 * lib.rs and constants.ts, which the Workers WebCrypto adapter enforces. This
 * pins the TypeScript copies to the Rust ones, so a change to one fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_AAD_SIZE, MAX_CIPHERTEXT_SIZE, MAX_PLAINTEXT_SIZE } from './constants.js';

const BINDINGS = ['cachekit-core-ts', 'cachekit-core-wasm'];

/** Evaluate `const NAME: usize = <expr>;`, where expr is integers, `*`, `+` and earlier names. */
function rustConst(source: string, name: string, known: Record<string, number>): number {
  const match = new RegExp(`const ${name}: usize = ([^;]+);`).exec(source);
  if (!match) throw new Error(`${name} not found`);
  return match[1].split('+').reduce((sum, term) => {
    const product = term
      .trim()
      .split('*')
      .reduce((acc, factor) => {
        const f = factor.trim();
        const value = /^\d+$/.test(f) ? Number(f) : known[f];
        if (value === undefined) throw new Error(`${name}: cannot evaluate "${f}"`);
        return acc * value;
      }, 1);
    return sum + product;
  }, 0);
}

describe('encryption size limits match the native bindings', () => {
  it.each(BINDINGS)('%s', (binding) => {
    const source = readFileSync(new URL(`../../${binding}/src/lib.rs`, import.meta.url), 'utf8');
    const plaintext = rustConst(source, 'MAX_PLAINTEXT_SIZE', {});
    expect(plaintext).toBe(MAX_PLAINTEXT_SIZE);
    expect(rustConst(source, 'MAX_CIPHERTEXT_SIZE', { MAX_PLAINTEXT_SIZE: plaintext })).toBe(
      MAX_CIPHERTEXT_SIZE
    );
    expect(rustConst(source, 'MAX_AAD_SIZE', {})).toBe(MAX_AAD_SIZE);
  });
});
