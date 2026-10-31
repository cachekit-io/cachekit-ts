// An app whose static import graph loads the built ES module entry and then
// @noble/hashes itself, so noble is linked but not yet evaluated when the
// package loads. Prints a key and a File backend name:
//
//   node noble-after-probe.mjs
import { generateKey } from '../../dist/index.js';
import '@noble/hashes/blake2.js';
import { blake2b16Hex } from '../../dist/serialization/key-generator.js';

const key = generateKey('probe', [1]);
console.log(JSON.stringify({ key, fileName: blake2b16Hex(key) }));
