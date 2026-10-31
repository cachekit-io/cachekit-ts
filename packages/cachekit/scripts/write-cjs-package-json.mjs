/**
 * Writes dist/cjs/package.json, which gives the CommonJS build its `type` and
 * is the package scope its `#` imports resolve in. The CommonJS build never
 * preloads @noble/hashes (src/serialization/blake2b.ts).
 */
import { writeFileSync } from 'node:fs';

const pkg = {
  type: 'commonjs',
  imports: { '#noble-preload': './serialization/no-preload.js' },
};
writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  `${JSON.stringify(pkg, null, 2)}\n`
);
