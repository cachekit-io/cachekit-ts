/**
 * Writes dist/cjs/package.json, which gives the CommonJS build its `type` and
 * is the package scope its `#` imports resolve in. There `#noble-blake2` is
 * src/serialization/cjs-noble-blake2.ts, which loads @noble/hashes on first
 * use; the root package.json maps it to @noble/hashes itself.
 */
import { writeFileSync } from 'node:fs';

const pkg = {
  type: 'commonjs',
  imports: { '#noble-blake2': './serialization/cjs-noble-blake2.js' },
};
writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  `${JSON.stringify(pkg, null, 2)}\n`
);
