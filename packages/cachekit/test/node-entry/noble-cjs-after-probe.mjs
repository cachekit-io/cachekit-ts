// An ES module app that loads the built CommonJS entry through a CommonJS
// module, then imports @noble/hashes itself, and hashes once its imports have
// run. Prints the key and a File backend name:
//
//   node noble-cjs-after-probe.mjs
import { generateKey, blake2b16Hex } from './noble-cjs-after-boot.cjs';
import '@noble/hashes/blake2.js';

const key = generateKey('probe', [1]);
console.log(JSON.stringify({ key, fileName: blake2b16Hex(key) }));
