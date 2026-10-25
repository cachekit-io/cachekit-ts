// Loads a built ESM entry in this fresh process, makes one key, and reports it
// with whether the key hash ran through the binding:
//
//   node [--import hooks] key-probe.mjs <path to dist/index.js> <namespace> <JSON args>
import { pathToFileURL } from 'node:url';

const [entry, namespace, args] = process.argv.slice(2);
const { generateKey } = await import(pathToFileURL(entry).href);
const { usingKeyHashBinding } = await import(
  new URL('serialization/blake2b.js', pathToFileURL(entry)).href
);
console.log(
  JSON.stringify({ bound: usingKeyHashBinding(), key: generateKey(namespace, JSON.parse(args)) })
);
