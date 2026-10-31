// What `#noble-preload` (package.json `imports`) resolves to wherever
// @noble/hashes loads through noble-require.cts instead of a static import;
// blake2b.ts decides when. It declares the name the loader reads, so a bundler
// checking ES module exports finds it.
export const blake2b = undefined;
