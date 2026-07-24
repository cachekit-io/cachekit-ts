/**
 * Workers bundle guard (LAB-595 acceptance criterion).
 *
 * Bundles the built workers entrypoint with the `workerd` condition and
 * fails if anything Node-only leaks into the module graph: node:* builtins
 * (the entry must not require nodejs_compat), native .node addons, the NAPI
 * binding package, ioredis, or prom-client.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(pkgDir, 'dist', 'workers', 'index.js');

// Package filters match the bare specifier AND any deep subpath import
// (e.g. ioredis/built/Redis) — a subpath would otherwise slip past the guard.
const FORBIDDEN = [
  { name: 'node builtin', filter: /^node:/ },
  { name: 'native addon', filter: /\.node$/ },
  { name: 'NAPI binding package', filter: /^@cachekit-io\/cachekit-core-ts(\/|$)/ },
  { name: 'ioredis', filter: /^ioredis(\/|$)/ },
  { name: 'prom-client', filter: /^prom-client(\/|$)/ },
];

const violations = [];

const guardPlugin = {
  name: 'forbidden-imports-guard',
  setup(buildApi) {
    for (const { name, filter } of FORBIDDEN) {
      buildApi.onResolve({ filter }, (args) => {
        violations.push(`${name}: "${args.path}" imported by ${args.importer}`);
        // Mark external so the scan reports every violation instead of
        // stopping at the first unresolvable path.
        return { path: args.path, external: true };
      });
    }
  },
};

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd'],
    loader: { '.wasm': 'binary' },
    plugins: [guardPlugin],
    write: false,
    logLevel: 'silent',
  });
} catch (error) {
  console.error('bundle guard: esbuild failed to bundle the workers entry');
  console.error(error.message ?? error);
  process.exit(1);
}

if (violations.length > 0) {
  console.error('bundle guard: Node-only imports reached the workers entry graph:');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(
  'bundle guard OK: workers entry graph is free of node:*, .node, NAPI, ioredis, prom-client'
);
