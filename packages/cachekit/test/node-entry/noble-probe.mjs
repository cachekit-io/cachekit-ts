// Loads a built Node entry in this fresh process and reports whether
// @noble/hashes was loaded after the import, after a key was made, and after
// a hash only JS computes (a File backend name), with the key and the name:
//
//   node noble-probe.mjs <esm|cjs> <path to dist/index.js or dist/cjs/index.js>
//
// The package loads @noble/hashes, an ES module, through require(esm), and
// Node lists a module loaded that way in the CommonJS module cache.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const [format, entry] = process.argv.slice(2);
const load = (file) => (format === 'cjs' ? require(file) : import(pathToFileURL(file).href));
const nobleLoaded = () =>
  Object.keys(require.cache).some((file) =>
    file.replace(/\\/g, '/').includes('/node_modules/@noble/hashes/')
  );

const { generateKey } = await load(entry);
const afterImport = nobleLoaded();
const key = generateKey('probe', [1]);
const afterKey = nobleLoaded();
const { blake2b16Hex } = await load(join(dirname(entry), 'serialization', 'key-generator.js'));
const fileName = blake2b16Hex(key);
console.log(JSON.stringify({ afterImport, afterKey, afterJsHash: nobleLoaded(), key, fileName }));
