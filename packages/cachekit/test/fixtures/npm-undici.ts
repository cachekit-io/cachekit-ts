/**
 * The npm undici that miniflare (from @cloudflare/vitest-plugin) brings: the
 * public API an application installs a global dispatcher with, for tests that
 * need genuine undici dispatchers beside the undici Node bundles. Without a
 * dependency of its own, the version is miniflare's, so it is checked: tests
 * written for undici 7 must fail, not pass uncovered, if a bump moves it.
 */
import { createRequire } from 'node:module';

export interface Closable {
  close(): Promise<void>;
}

interface Composable extends Closable {
  compose(interceptor: unknown): Closable;
}

export interface NpmUndici {
  Agent: new (options?: object) => Composable;
  RetryAgent: new (agent: Closable, options: object) => Closable;
  Pool: new (origin: string, options: object) => Composable;
  MockAgent: new () => Closable & {
    disableNetConnect(): void;
    get(origin: string): {
      intercept(options: object): { reply(status: number, body: string): void };
    };
  };
  interceptors: { retry(options: object): unknown };
  setGlobalDispatcher(dispatcher: Closable): void;
}

const fromMiniflare = createRequire(
  createRequire(import.meta.resolve('@cloudflare/vitest-plugin')).resolve('miniflare')
);
const { version } = fromMiniflare('undici/package.json') as { version: string };
if (!version.startsWith('7.')) {
  throw new Error(`test/fixtures/npm-undici: expected undici 7 from miniflare, got ${version}`);
}

export const npmUndici = fromMiniflare('undici') as NpmUndici;
