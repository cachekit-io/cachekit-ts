/**
 * Writes dist/cjs/package.json. The CommonJS build sits inside a
 * `"type": "module"` package, so it needs its own package.json, and that file
 * is then the package scope its `#` imports resolve in. The CommonJS build
 * never preloads @noble/hashes (see src/serialization/blake2b.ts), so
 * #noble-preload is always the module with no exports.
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
