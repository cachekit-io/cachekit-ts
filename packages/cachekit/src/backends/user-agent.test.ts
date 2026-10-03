import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../version.js';
import { USER_AGENT, runtimeToken } from './user-agent.js';

describe('User-Agent', () => {
  it("VERSION is package.json's version (release-please bumps both)", () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('is cachekit-ts/<version> (<runtime>)', () => {
    expect(USER_AGENT).toBe(`cachekit-ts/${VERSION} (node)`);
  });

  it.each([
    ['Node.js/22', 'node'],
    ['Bun/1.3.8', 'bun'],
    ['Deno/2.5.0', 'deno'],
    ['Cloudflare-Workers', 'workerd'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'unknown'],
    [undefined, 'unknown'],
  ])('maps navigator.userAgent %s to %s', (userAgent, token) => {
    expect(runtimeToken(userAgent)).toBe(token);
  });
});
