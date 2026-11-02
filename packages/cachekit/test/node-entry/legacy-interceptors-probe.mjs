// Undici 6 (Node 22) lets an Agent's interceptors be replaced after it is
// built, through its public `interceptors` setter, without touching its
// options. This builds an Agent with Node's own Agent class and defaults,
// replaces its interceptors with one that sends every request twice, each
// from its own copy of the headers, and installs it as the global
// dispatcher. It then makes one GET with a latency report waiting, and prints
// what each attempt on the wire carried and whether the report still waits.
// Later undici majors have no such setter, so there the probe changes nothing:
//
//   node legacy-interceptors-probe.mjs <path to dist/backends/cachekitio.js>
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { CachekitIOCore } = await import(pathToFileURL(process.argv[2]).href);

void globalThis.Headers; // loads Node's undici, which fills its global slots
const major = Number.parseInt(process.versions.undici, 10);
const slot = Symbol.for(major >= 8 ? 'undici.globalDispatcher.2' : 'undici.globalDispatcher.1');
const agent = new globalThis[slot].constructor();
const discard = {
  onConnect() {},
  onHeaders: () => true,
  onData: () => true,
  onComplete() {},
  onError() {},
};
agent.interceptors = [
  (dispatch) => (options, handler) => {
    dispatch({ ...options, headers: { ...options.headers } }, discard);
    return dispatch({ ...options, headers: { ...options.headers } }, handler);
  },
];
globalThis[slot] = agent;

const seen = [];
const server = createServer((request, response) => {
  seen.push(request.headers['x-cachekit-l1-latency-sum-ns'] ?? null);
  response.writeHead(404).end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const nodeFetch = globalThis.fetch;
// Only the destination changes: the backend's options reach fetch unchanged.
globalThis.fetch = (url, init) =>
  nodeFetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
delete process.env.CACHEKIT_TELEMETRY;
const backend = new CachekitIOCore({
  apiKey: 'ck_test_fake-not-a-secret', // pragma: allowlist secret
  apiUrl: 'https://api.test.cachekit.io',
  allowCustomHost: true,
});
try {
  backend.l1Latency.record(300);
  await backend.get('ns:k');
  // The copy the interceptor discards may land after the answer.
  for (let waited = 0; seen.length < (major === 6 ? 2 : 1) && waited < 2000; waited += 20) {
    await sleep(20);
  }
  const waits = backend.l1Latency.take()?.['X-CacheKit-L1-Latency-Sum-Ns'] ?? null;
  console.log(JSON.stringify({ undici: major, seen, waits }));
} finally {
  await backend.close();
  await agent.close();
  server.closeAllConnections();
  server.close();
}
