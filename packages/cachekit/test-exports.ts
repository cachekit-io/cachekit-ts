import type {
  Cache,
  SecureCache,
  CacheOptions,
  WrapOptions,
  SetOptions,
  EncryptionConfig,
  ReliabilityConfig,
} from './src/index.js';

// Type-only import to verify they're exported
const testTypes: {
  cache: Cache;
  secureCache: SecureCache;
  cacheOptions: CacheOptions;
  wrapOptions: WrapOptions;
  setOptions: SetOptions;
  encryptionConfig: EncryptionConfig;
  reliabilityConfig: ReliabilityConfig;
} = {} as any;

console.log('All cache types successfully exported');
