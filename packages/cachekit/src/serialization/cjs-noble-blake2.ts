import type * as Blake2 from '@noble/hashes/blake2.js';

// What `#noble-blake2` resolves to in the CommonJS build (dist/cjs/package.json
// `imports`); this file is compiled into that build only. The ES module build
// imports @noble/hashes itself.
//
// @noble/hashes is ESM-only, so CommonJS loads it through require(esm). On
// Node.js 24 and later it loads the first time anything hashes in JS: keys hash
// through the native binding, and loading noble costs about 5 ms of a cold
// start. On Node 22 and 23 it loads here, at require: their module loader keeps
// the async context a module is first loaded in (a request's AsyncLocalStorage
// store) for the life of the process. Either way only the module is loaded
// here; its `blake2b` is read at each call.

let noble: typeof Blake2 | undefined;

function load(): typeof Blake2 {
  if (noble !== undefined) return noble;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a synchronous load is this file's purpose
    noble = require('@noble/hashes/blake2.js') as typeof Blake2;
  } catch (error) {
    const hint = process.features.require_module ? '' : ', which needs Node.js 22.12 or later';
    throw new Error(`[cachekit] could not load @noble/hashes through require(esm)${hint}`, {
      cause: error,
    });
  }
  return noble;
}

if (Number(process.versions.node.split('.')[0]) < 24) load();

/** @noble/hashes' unkeyed BLAKE2b of `data`, `dkLen` bytes long. */
export function blake2b(data: Uint8Array, opts: { dkLen: number }): Uint8Array {
  return load().blake2b(data, opts);
}
