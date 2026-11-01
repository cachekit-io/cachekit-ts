// The CommonJS module noble-cjs-after-probe.mjs imports before @noble/hashes.
const { generateKey } = require('../../dist/cjs/index.js');
const { blake2b16Hex } = require('../../dist/cjs/serialization/key-generator.js');

module.exports = { generateKey, blake2b16Hex };
