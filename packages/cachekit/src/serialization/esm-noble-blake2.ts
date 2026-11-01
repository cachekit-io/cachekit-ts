// What `#noble-blake2` resolves to in the built ES module entries, Workers
// included (dist/package.json `imports`); this file is compiled into that build
// only. A relative target, unlike the root package.json's `@noble/hashes` one,
// which serves source runs: file tracers that bundle serverless functions follow
// a relative `imports` target, and some cannot follow one naming another package.
export { blake2b } from '@noble/hashes/blake2.js';
