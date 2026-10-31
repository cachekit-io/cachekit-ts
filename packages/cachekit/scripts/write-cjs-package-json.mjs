/**
 * Writes dist/cjs/package.json, which gives the CommonJS build its `type` and
 * is the package scope its `#` imports resolve in. The CommonJS build always
 * loads @noble/hashes through src/serialization/noble-require.cts, never a
 * static import.
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
