import { createServer, type Socket } from 'node:net';

/**
 * A RESP2 server that answers the commands the Redis backend sends: the
 * connect handshake (INFO ready check, CLIENT SETINFO), SET/SETEX, GET and
 * QUIT. Enough to prove a real ioredis client works end to end without a
 * Redis server; any other command gets an error reply.
 */
export interface FakeRedis {
  url: string;
  close(): Promise<void>;
}

const CRLF = '\r\n';

/** Parse one command (an array of bulk strings) off the front of `buf`. */
function parseCommand(buf: Buffer): { args: Buffer[]; length: number } | null {
  const readLine = (from: number): { line: string; next: number } | null => {
    const end = buf.indexOf(CRLF, from);
    return end === -1 ? null : { line: buf.toString('latin1', from, end), next: end + 2 };
  };
  const header = readLine(0);
  if (!header) return null;
  // An inline command: answered with the unsupported-command error.
  if (!header.line.startsWith('*')) {
    return { args: [Buffer.from(header.line)], length: header.next };
  }
  const args: Buffer[] = [];
  let at = header.next;
  for (let i = 0; i < Number(header.line.slice(1)); i++) {
    const size = readLine(at);
    if (!size) return null;
    const end = size.next + Number(size.line.slice(1));
    if (buf.length < end + 2) return null;
    args.push(buf.subarray(size.next, end));
    at = end + 2;
  }
  return { args, length: at };
}

const bulk = (value: Buffer | string): Buffer => {
  const body = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([Buffer.from(`$${body.length}${CRLF}`), body, Buffer.from(CRLF)]);
};

export async function startFakeRedis(): Promise<FakeRedis> {
  const store = new Map<string, Buffer>();
  const sockets = new Set<Socket>();

  const reply = (args: Buffer[]): Buffer => {
    const name = args[0]?.toString().toUpperCase();
    switch (name) {
      case 'INFO':
        return bulk(`# Server${CRLF}redis_version:7.0.0${CRLF}loading:0${CRLF}`);
      case 'CLIENT':
      case 'QUIT':
        return Buffer.from(`+OK${CRLF}`);
      case 'SET':
        store.set(args[1].toString(), Buffer.from(args[2]));
        return Buffer.from(`+OK${CRLF}`);
      case 'SETEX':
        store.set(args[1].toString(), Buffer.from(args[3]));
        return Buffer.from(`+OK${CRLF}`);
      case 'GET': {
        const value = store.get(args[1].toString());
        return value ? bulk(value) : Buffer.from(`$-1${CRLF}`);
      }
      default:
        return Buffer.from(`-ERR fake-redis: unsupported command ${name}${CRLF}`);
    }
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      for (let command = parseCommand(pending); command; command = parseCommand(pending)) {
        pending = pending.subarray(command.length);
        socket.write(reply(command.args));
        if (command.args[0]?.toString().toUpperCase() === 'QUIT') socket.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake-redis: no TCP port');

  return {
    url: `redis://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
