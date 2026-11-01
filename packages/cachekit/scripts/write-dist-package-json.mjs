/**
 * Writes dist/package.json and dist/cjs/package.json. Each gives its build its
 * `type`, and is the package scope that build's `#` imports resolve in. There
 * `#noble-blake2` is a file inside the build: src/serialization/esm-noble-blake2.ts
 * (a static import of @noble/hashes) for the ES module build, and
 * src/serialization/cjs-noble-blake2.ts for the CommonJS build, which loads
 * @noble/hashes at require below Node 24 and on first use from 24.
 */
import { writeFileSync } from 'node:fs';

const write = (dir, type, target) =>
  writeFileSync(
    new URL(`../dist/${dir}package.json`, import.meta.url),
    `${JSON.stringify({ type, imports: { '#noble-blake2': target } }, null, 2)}\n`
  );

write('', 'module', './serialization/esm-noble-blake2.js');
write('cjs/', 'commonjs', './serialization/cjs-noble-blake2.js');
