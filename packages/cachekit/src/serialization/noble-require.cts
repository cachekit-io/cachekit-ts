// Plain JavaScript, no TypeScript syntax: Vite (so Vitest) parses .cts as JS.
// This file is CommonJS in both builds, so ES module code gets a synchronous
// `require` that resolves from this package through it.

/** @noble/hashes' BLAKE2b module. It is ESM-only, so this needs require(esm). */
export function requireNobleBlake2() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a synchronous load is this file's purpose
    return require('@noble/hashes/blake2.js');
  } catch (error) {
    throw new Error(
      '[cachekit] could not load @noble/hashes, which CommonJS loads through require(esm) (Node.js 22.12 or later)',
      { cause: error }
    );
  }
}

/** Whether @noble/hashes' BLAKE2b module can be found from this package. */
export function nobleBlake2Resolves() {
  try {
    require.resolve('@noble/hashes/blake2.js');
    return true;
  } catch {
    return false;
  }
}
