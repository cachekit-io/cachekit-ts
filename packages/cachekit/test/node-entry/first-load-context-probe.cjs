// Loads the package's own modules inside an AsyncLocalStorage context, as a
// first import in a request handler does, and calls a function wrapped there;
// then reports whether that context outlived the request:
//
//   node --expose-gc first-load-context-probe.cjs <path to dist/cjs/index.js> <ttl> <wait ms>
//
// The entry is loaded once outside the context and its own modules (those in
// its directory) are then dropped from the module cache, so the load inside
// the context runs only the package's own code; its dependencies stay loaded.
// The context's store holds a 1 MiB body that the wrapped function never sees.
// After the request, the probe collects garbage every 20 ms for up to
// <wait ms>, stopping once the store is gone.
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');

const [entry, ttl, wait] = process.argv.slice(2);
const own = path.dirname(path.resolve(entry)) + path.sep;
require(entry);
for (const file of Object.keys(require.cache)) {
  if (file.startsWith(own)) delete require.cache[file];
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
