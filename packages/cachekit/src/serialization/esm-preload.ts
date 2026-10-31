import type * as Blake2 from '@noble/hashes/blake2.js';

// What `#noble-preload` (package.json `imports`) resolves to in the ES module
// build wherever require(esm) runs: Node.js 22.12 and later.
//
// On Node 22 and 23, noble loads here, as a dependency of this package, so it
// is evaluated before any of this package's code runs, as a static import
// would be. A require(esm) cannot give that order: up to Node 22.17 and on
// 23, it fails for a module the app's own import graph has linked but not yet
// evaluated, as when a module the app imports first makes a cache call and
// the app imports @noble/hashes after it. Node 22's loader also keeps the
// async context a module is first loaded in, so loading here keeps noble out
// of any request.
//
// On Node 24 and later, nothing loads here: noble loads on first use
// (blake2b.ts). Outside Node, `process` is absent and the same holds.
export const blake2b: typeof Blake2.blake2b | undefined =
  Number(globalThis.process?.versions?.node?.split('.')[0]) < 24
    ? (await import('@noble/hashes/blake2.js')).blake2b
    : undefined;
