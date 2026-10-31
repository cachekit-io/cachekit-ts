// Loads the package's own modules inside an AsyncLocalStorage context, as a
// first import in a request handler does, and calls a function wrapped there;
// then reports whether that context outlived the request:
//
//   node --expose-gc first-load-context-probe.cjs <path to dist/cjs/index.js> <ttl> <wait ms> [cold|js-hash]
//
// With `js-hash`, the request also makes the process's first hash in JS (a
// File backend name), the point where Node.js 24 and later load @noble/hashes.
//
// By default the entry is loaded once outside the context and its own modules
// (those in its directory) are then dropped from the module cache, so the load
// inside the context runs only the package's own code; its dependencies stay
// loaded. With `cold`, nothing is loaded beforehand, so the load inside the
// context also runs every dependency's, the native core's included. The one
// exception is Node.js 22, where `@noble/hashes` is preloaded: Node 22's ES
// module loader keeps the context of any ES module first loaded inside one,
// which is Node's behaviour, not the package's.
// The context's store holds a 1 MiB body that the wrapped function never sees.
// After the request, the probe collects garbage every 20 ms for up to
// <wait ms>, stopping once the store is gone.
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const [entry, ttl, wait, mode] = process.argv.slice(2);
if (mode === 'cold') {
  if (process.versions.node.split('.')[0] === '22') {
    require(require.resolve('@noble/hashes/blake2.js', { paths: [path.dirname(entry)] }));
  }
} else {
  const own = path.dirname(path.resolve(entry)) + path.sep;
  require(entry);
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(own)) delete require.cache[file];
  }
}

const storage = new AsyncLocalStorage();
const backend = {
  get: async () => null,
  set: async () => {},
  delete: async () => true,
  exists: async () => false,
  close: async () => {},
};

async function request() {
  const store = { body: 'x'.repeat(1 << 20) };
  await storage.run(store, async () => {
    const { createCache } = require(entry);
    const cache = createCache({ backend, metrics: false });
    const fn = cache.wrap(async (id) => ({ id }), { namespace: 'probe', ttl: Number(ttl) });
    await fn(1);
    await fn(1);
    if (mode === 'js-hash') {
      // The first hash in JS: on Node.js 24 and later, it loads @noble/hashes here.
      require(path.join(path.dirname(entry), 'serialization', 'key-generator.js')).blake2b16Hex(
        'probe'
      );
    }
  });
  return new WeakRef(store);
}

(async () => {
  const store = await request();
  const deadline = Date.now() + Number(wait);
  do {
    await new Promise((resolve) => setTimeout(resolve, 20));
    global.gc();
  } while (store.deref() !== undefined && Date.now() < deadline);
  console.log(JSON.stringify({ retained: store.deref() !== undefined }));
})();
