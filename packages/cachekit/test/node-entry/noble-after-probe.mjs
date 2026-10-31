// An app whose static import graph runs a module that uses the built ES module
// entry, then imports @noble/hashes itself. noble is linked but not yet
// evaluated while that module runs, and the module hashes in JS (a File
// backend name) as it does. Prints the key and the name:
//
//   node noble-after-probe.mjs
import './noble-after-probe-bootstrap.mjs';
import '@noble/hashes/blake2.js';
