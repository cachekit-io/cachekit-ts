// No TypeScript syntax here: Vite (and so Vitest) parses a .cts file as plain
// JavaScript. The caller types the module it returns.

/**
 * @noble/hashes' BLAKE2b module, loaded synchronously. This file is CommonJS
 * in both builds, so ES module code reaches a `require` that resolves from
 * this package through it. @noble/hashes is ESM-only, so this needs Node's
 * require(esm), unflagged from Node.js 22.12.
 */
export function requireNobleBlake2() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a synchronous load is this file's purpose
    return require('@noble/hashes/blake2.js');
  } catch (error) {
    throw new Error(
      '[cachekit] hashing in JS needs require(esm) to load @noble/hashes: use Node.js 22.12 or later',
      { cause: error }
    );
  }
}
