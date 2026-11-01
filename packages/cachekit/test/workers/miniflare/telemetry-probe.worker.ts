/**
 * A Worker that drives the SDK's Workers entry for telemetry.miniflare.test.ts.
 * Each path makes CachekitIO requests one way; the test reads the headers
 * they carried off its outbound service.
 */
import { cachekitio, createCache } from '../../../src/workers/index.js';

const API_KEY = 'ck_test_fake-not-a-secret'; // pragma: allowlist secret
const COUNTERS = { l1Hits: 3, l2Hits: 1, misses: 1, l1Enabled: true };

type Flags = { Cloudflare?: { compatibilityFlags?: Record<string, boolean> } };

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    switch (new URL(request.url).pathname) {
      case '/runtime':
        return Response.json({
          disallowImportableEnv: (globalThis as Flags).Cloudflare?.compatibilityFlags
            ?.disallow_importable_env,
          binding: env.CACHEKIT_TELEMETRY ?? null,
        });
      case '/instance':
        await cachekitio({ apiKey: API_KEY, metricsProvider: () => COUNTERS }).get('svc:k');
        break;
      case '/instance-telemetry-true':
        await cachekitio({
          apiKey: API_KEY,
          telemetry: true,
          metricsProvider: () => COUNTERS,
        }).get('svc:k');
        break;
      case '/config':
      case '/io': {
        const cache = request.url.endsWith('/io')
          ? createCache.io({ apiKey: API_KEY, metrics: false })
          : createCache({ backend: { apiKey: API_KEY }, metrics: false });
        await cache.set('svc:k', 1);
        await cache.get('svc:other');
        await cache.close();
        break;
      }
      default:
        return new Response('unknown path', { status: 404 });
    }
    return new Response('ok');
  },
};
