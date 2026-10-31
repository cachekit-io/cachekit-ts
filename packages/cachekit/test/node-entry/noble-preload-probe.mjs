// Resolves `#noble-preload` from inside the package, as the built ES module
// entry does, and prints whether it holds noble's blake2b:
//
//   node noble-preload-probe.mjs
import * as preloaded from '#noble-preload';

console.log(typeof preloaded.blake2b);
