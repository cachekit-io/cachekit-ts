// The module noble-after-probe.mjs imports before @noble/hashes.
import { generateKey } from '../../dist/index.js';
import { blake2b16Hex } from '../../dist/serialization/key-generator.js';

const key = generateKey('probe', [1]);
console.log(JSON.stringify({ key, fileName: blake2b16Hex(key) }));
