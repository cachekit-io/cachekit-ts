import { generateKey, generateParamsHash } from './key-generator.js';

/**
 * The auto-mode keys of one wrapped function, `{namespace}:{hash}` exactly as
 * generateKey builds them. The `{namespace}:` prefix is the part that does not
 * depend on the arguments, so it is built once and rebuilt only when the
 * namespace changes: wrap() reads the namespace from its options on every call.
 */
export class AutoKeys {
  private namespace: string | undefined;
  private prefix = '';

  key(namespace: string, args: unknown[]): string {
    // A JavaScript caller can pass any namespace: key it as generateKey does.
    if (typeof namespace !== 'string') return generateKey(namespace, args);
    const hash = generateParamsHash(args);
    if (namespace !== this.namespace) {
      this.namespace = namespace;
      this.prefix = `${namespace}:`;
    }
    return this.prefix + hash;
  }
}
