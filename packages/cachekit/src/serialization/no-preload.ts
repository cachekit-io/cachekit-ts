// What `#noble-preload` (package.json `imports`) resolves to in the CommonJS
// build, which loads @noble/hashes through noble-require.cts instead;
// blake2b.ts decides when. It declares the name the loader reads, so a bundler
// checking ES module exports finds it.
export const blake2b = undefined;
