// What `#noble-preload` resolves to in the CommonJS build (dist/cjs/package.json
// `imports`), which loads @noble/hashes through noble-require.cts instead;
// blake2b.ts decides when. It declares `blake2b` as an own property, so the
// loader never reads one inherited from Object.prototype.
export const blake2b = undefined;
