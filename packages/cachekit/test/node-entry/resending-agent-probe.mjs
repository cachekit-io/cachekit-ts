// Builds an Agent with Node's own Agent class that resends, in a way no
// option check can see, installs it as the global dispatcher, makes one GET
// with a latency report waiting, and prints what each attempt on the wire
// carried and whether the report still waits. The Agent sends every request
// twice, each attempt from its own copy of the headers, through:
//
//   interceptors  undici 6's public `interceptors` setter, after the Agent is
//                 built with defaults (later majors have no such setter, so
//                 there the probe changes nothing);
//   factory       a factory that only shares the name `defaultFactory`.
//
//   node resending-agent-probe.mjs <path to dist/backends/cachekitio.js> <interceptors|factory>
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [dist, how] = process.argv.slice(2);
const { CachekitIOCore } = await import(pathToFileURL(dist).href);

void globalThis.Headers; // loads Node's undici, which fills its global slots
const major = Number.parseInt(process.versions.undici, 10);
const slot = Symbol.for(major >= 8 ? 'undici.globalDispatcher.2' : 'undici.globalDispatcher.1');
const NodeAgent = globalThis[slot].constructor;

/** A handler that takes a response and drops it, in the API `handler` uses. */
function discarding(handler) {
  return 'onRequestStart' in handler
    ? {
        onRequestStart() {},
        onResponseStart() {},
        onResponseData() {},
        onResponseEnd() {},
        onResponseError() {},
      }
    : { onConnect() {}, onHeaders: () => true, onData: () => true, onComplete() {}, onError() {} };
}

/** Dispatch through `send` twice, each attempt with its own copy of the headers. */
const twice = (send) => (options, handler) => {
  send({ ...options, headers: { ...options.headers } }, discarding(handler));
  return send({ ...options, headers: { ...options.headers } }, handler);
};

let agent;
if (how === 'interceptors') {
  agent = new NodeAgent();
  agent.interceptors = [twice];
} else if (how === 'factory') {
  agent = new NodeAgent({
    factory: function defaultFactory() {
      const inner = new NodeAgent();
      inner.dispatch = twice(inner.dispatch.bind(inner));
      return inner;
    },
  });
} else {
  throw new Error(`resending-agent-probe: unknown mode ${how}`);
}
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
  // The attempt the Agent discards may land after the answer.
  const attempts = how === 'interceptors' && major !== 6 ? 1 : 2;
  for (let waited = 0; seen.length < attempts && waited < 2000; waited += 20) {
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
