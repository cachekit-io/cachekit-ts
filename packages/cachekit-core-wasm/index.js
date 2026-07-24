// Workers-only entry. The .wasm import resolves to a WebAssembly.Module
// under wrangler / workerd / vitest-pool-workers (CompiledWasm module rule).
// It does NOT resolve under plain Node — Node consumers use the NAPI sibling
// @cachekit-io/cachekit-core-ts instead.
import wasmModule from './pkg/cachekit_core_wasm_bg.wasm';
import { initSync } from './pkg/cachekit_core_wasm.js';

export {
  ByteStorage,
  TenantKeys,
  deriveKey,
  deriveTenantKeys,
  encryptWithTenantKeys,
  decryptWithTenantKeys,
  version,
  initSync,
} from './pkg/cachekit_core_wasm.js';

let initialized = false;

/**
 * Instantiate the bundled wasm module (synchronous, idempotent).
 *
 * Must be called before any other export is used. Instantiation is a
 * one-time cost per isolate (~150 KB module); Workers permits synchronous
 * `new WebAssembly.Instance` on precompiled modules.
 */
export function ensureInitialized() {
  if (!initialized) {
    initSync({ module: wasmModule });
    initialized = true;
  }
}
