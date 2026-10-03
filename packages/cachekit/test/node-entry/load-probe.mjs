// Loads a built Node entry in this fresh process and reports whether ioredis
// was loaded after the import, and again after a Redis backend was created:
//
//   node load-probe.mjs <esm|cjs> <path to dist/index.js or dist/cjs/index.js>
//
// The CommonJS module cache also holds the CommonJS modules an ES module
// imports, and ioredis is CommonJS, so one check covers both entries.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const [format, entry] = process.argv.slice(2);
const ioredisLoaded = () =>
  Object.keys(require.cache).some((file) =>
    file.replace(/\\/g, '/').includes('/node_modules/ioredis/')
  );

const { redis } = format === 'cjs' ? require(entry) : await import(pathToFileURL(entry).href);
const afterImport = ioredisLoaded();
// Nothing listens on port 1; close() waits for ioredis to load and the client
// to be created, then drops the connection attempt.
await redis({ url: 'redis://127.0.0.1:1' }).close();
console.log(JSON.stringify({ afterImport, afterRedis: ioredisLoaded() }));
