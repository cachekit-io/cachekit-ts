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

// ── Type-closure guard (LAB-1388) ──────────────────────────────────────────
// Same invariant at the type level: build a program over the workers entry's
// published declaration closure and fail if any Node-typed declarations get
// pulled in (ioredis, prom-client, @types/node). On 0.1.5, a nominal
// `import type { Redis } from 'ioredis'` in the shared type module forced
// every Workers consumer without @types/node into skipLibCheck over dozens
// of `Cannot find name 'Buffer'` errors inside ioredis/built/**.
//
// The detection is a file scan of the program's resolved sources, NOT just
// diagnostics: in THIS repo @types/node is installed, so a leaked ioredis
// reference typechecks clean here while still breaking consumers that don't
// have it. Diagnostics are checked too (with skipLibCheck off) so the
// closure is also proven self-consistent against ES+DOM libs alone.
let ts;
try {
  ts = (await import('typescript')).default;
} catch (error) {
  console.error('type-closure guard: failed to load the typescript compiler (devDependency)');
  console.error(error?.message ?? error);
  process.exit(1);
}

const typesEntry = join(pkgDir, 'dist', 'workers', 'index.d.ts');
const compilerOptions = {
  noEmit: true,
  strict: true,
  skipLibCheck: false,
  types: [],
  // ES lib only, plus DOM for the fetch/Response/caches types the Workers
  // backends reference structurally. Deliberately NO Node lib/types.
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

const program = ts.createProgram([typesEntry], compilerOptions);

const FORBIDDEN_TYPE_SOURCES = [
  { name: 'ioredis declarations', filter: /node_modules\/ioredis\// },
  { name: 'prom-client declarations', filter: /node_modules\/prom-client\// },
  { name: '@types/node', filter: /node_modules\/@types\/node\// },
];

const typeViolations = [];
for (const sourceFile of program.getSourceFiles()) {
  const fileName = sourceFile.fileName.replace(/\\/g, '/');
  for (const { name, filter } of FORBIDDEN_TYPE_SOURCES) {
    if (filter.test(fileName)) {
      typeViolations.push(`${name}: ${fileName}`);
    }
  }
}

if (typeViolations.length > 0) {
  console.error('type-closure guard: Node-typed declarations reached the workers .d.ts closure:');
  for (const violation of typeViolations.slice(0, 10)) {
    console.error(`  - ${violation}`);
  }
  if (typeViolations.length > 10) {
    console.error(`  ... and ${typeViolations.length - 10} more`);
  }
  process.exit(1);
}

const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  console.error('type-closure guard: workers .d.ts closure fails without Node types:');
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 20), {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => pkgDir,
      getNewLine: () => '\n',
    })
  );
  if (diagnostics.length > 20) {
    console.error(`  ... and ${diagnostics.length - 20} more`);
  }
  process.exit(1);
}

console.log(
  'type-closure guard OK: workers .d.ts closure is free of ioredis / prom-client / @types/node'
);
