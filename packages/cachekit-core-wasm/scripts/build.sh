#!/usr/bin/env bash
# Build the wasm32 artifact: cargo → wasm-bindgen → wasm-opt → budget checks.
#
# Prerequisites: rustup target wasm32-unknown-unknown, wasm-bindgen CLI at the
# version pinned in Cargo.lock, binaryen (wasm-opt).
set -euo pipefail
cd "$(dirname "$0")/.."

# wasm-bindgen CLI must match the crate's pinned wasm-bindgen version —
# mismatched glue fails at runtime, not build time.
PINNED=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | grep '^version' | cut -d'"' -f2)
CLI=$(wasm-bindgen --version | awk '{print $2}')
if [ "$PINNED" != "$CLI" ]; then
  echo "error: wasm-bindgen CLI $CLI != pinned crate version $PINNED" >&2
  echo "install: cargo install wasm-bindgen-cli --version $PINNED --locked" >&2
  exit 1
fi

cargo build --release --target wasm32-unknown-unknown

# --target web: wrangler serves .wasm imports as CompiledWasm
# (WebAssembly.Module) and index.js instantiates explicitly via initSync.
wasm-bindgen --target web --out-dir pkg \
  target/wasm32-unknown-unknown/release/cachekit_core_wasm.wasm

# Rust emits bulk-memory / nontrapping-fptoint ops by default; workerd
# supports both, wasm-opt just needs them enabled to validate.
wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
  -o pkg/cachekit_core_wasm_bg.wasm pkg/cachekit_core_wasm_bg.wasm

# Size budget (LAB-595 acceptance criterion): gzipped wasm < 100 KB.
RAW=$(wc -c < pkg/cachekit_core_wasm_bg.wasm)
GZ=$(gzip -9 -c pkg/cachekit_core_wasm_bg.wasm | wc -c)
echo "wasm artifact: ${RAW} bytes raw, ${GZ} bytes gzipped"
if [ "$GZ" -ge 102400 ]; then
  echo "error: size budget exceeded — ${GZ} bytes gzipped >= 102400 (100 KB)" >&2
  exit 1
fi

# API-surface drift check, both directions:
# 1. every export wasm-bindgen generated must be declared in the committed
#    index.d.ts (which TS consumers type against);
# 2. every declaration in index.d.ts must exist in the generated surface —
#    a stale declaration for a renamed/removed Rust export would type-check
#    and then fail at runtime.
DRIFT=0
while read -r name; do
  if ! grep -q "declare \(class\|function\) ${name}\b" index.d.ts; then
    echo "error: pkg export '${name}' missing from index.d.ts" >&2
    DRIFT=1
  fi
done < <(grep -o '^export \(class\|function\) [A-Za-z_][A-Za-z0-9_]*' pkg/cachekit_core_wasm.d.ts | awk '{print $3}')
while read -r name; do
  # ensureInitialized lives in the hand-written index.js wrapper, and
  # initSync is wasm-bindgen runtime glue (present in pkg, different shape).
  case "$name" in ensureInitialized|initSync) continue ;; esac
  if ! grep -q "^export \(class\|function\) ${name}\b" pkg/cachekit_core_wasm.d.ts; then
    echo "error: index.d.ts declares '${name}' but pkg no longer exports it" >&2
    DRIFT=1
  fi
done < <(grep -o '^export declare \(class\|function\) [A-Za-z_][A-Za-z0-9_]*' index.d.ts | awk '{print $4}')
if [ "$DRIFT" -ne 0 ]; then
  echo "update index.d.ts to match the generated pkg/cachekit_core_wasm.d.ts" >&2
  exit 1
fi

echo "build OK"
