// Loads Node's own undici before any npm undici can fill its global slots,
// then prints, for Node's default global dispatcher and for Agents built with
// Node's own Agent class, whether oneAttemptDispatcher accepts each:
//
//   node default-dispatcher-probe.mjs <path to dist/backends/one-attempt-dispatcher.js>
import { pathToFileURL } from 'node:url';

const { oneAttemptDispatcher } = await import(pathToFileURL(process.argv[2]).href);

void globalThis.Headers; // loads Node's undici, which fills its global slots
const major = Number.parseInt(process.versions.undici, 10);
const slot = Symbol.for(major >= 8 ? 'undici.globalDispatcher.2' : 'undici.globalDispatcher.1');
const ownDefault = globalThis[slot];
const NodeAgent = ownDefault.constructor;

function accepts(dispatcher) {
  globalThis[slot] = dispatcher;
  try {
    return oneAttemptDispatcher() !== undefined;
  } finally {
    globalThis[slot] = ownDefault;
  }
}

console.log(
  JSON.stringify({
    undici: major,
    'the default': accepts(ownDefault),
    'new Agent()': accepts(new NodeAgent()),
    allowH2: accepts(new NodeAgent({ allowH2: true })),
    'connect.allowH2': accepts(new NodeAgent({ connect: { allowH2: true } })),
    'a connect function': accepts(new NodeAgent({ connect: () => undefined })),
    'a factory': accepts(new NodeAgent({ factory: () => undefined })),
    pipelining: accepts(new NodeAgent({ pipelining: 2 })),
    'a CA only': accepts(new NodeAgent({ connect: { ca: 'x' } })),
    maxRedirections: accepts(new NodeAgent({ maxRedirections: 1 })),
    'a subclass named Agent': accepts(new (class Agent extends NodeAgent {})()),
    'a subclass named Agent, through a class named DispatcherBase': accepts(
      new (class Agent extends class DispatcherBase extends NodeAgent {} {})()
    ),
  })
);
