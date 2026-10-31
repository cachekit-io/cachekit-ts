// What `#noble-preload` (package.json `imports`) resolves to wherever
// @noble/hashes loads on first use instead. It declares the name the loader
// reads, so a bundler checking ES module exports finds it.
export const blake2b = undefined;
