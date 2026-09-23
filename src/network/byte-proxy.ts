import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import net from 'node:net';

/**
 * Minimal forward proxy (HTTP + CONNECT tunnels) that counts the bytes a browser moves over the
 * network. Every browser is routed through it, so all of them are measured the same way, whatever
 * their driver exposes. HTTPS stays end-to-end encrypted: tunnels are relayed byte for byte, and the
 * counts include TLS overhead, i.e. what a metered proxy would bill.
 */
export interface ByteCounts {
  bytesDown: number;
  bytesUp: number;
}

export interface ByteProxy {
  /** Proxy URL as seen from this machine. */
  url: string;
  reset(): void;
  read(): ByteCounts;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

export async function startByteProxy(extraHosts: string[] = []): Promise<ByteProxy> {
  const counts: ByteCounts = { bytesDown: 0, bytesUp: 0 };
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const handler: http.RequestListener = (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('absolute URL required');
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    counts.bytesUp += req.rawHeaders.join('').length;
    const upstream = http.request(
      { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers },
      (upstreamRes) => {
        counts.bytesDown += upstreamRes.rawHeaders.join('').length;
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.on('data', (chunk: Buffer) => { counts.bytesDown += chunk.length; });
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('data', (chunk: Buffer) => { counts.bytesUp += chunk.length; });
    req.pipe(upstream);
  };

  const onConnect = (req: http.IncomingMessage, client: Socket, head: Buffer) => {
    const [host, port] = (req.url ?? '').split(':');
    track(client);
    const upstream = net.connect(Number(port) || 443, host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        counts.bytesUp += head.length;
        upstream.write(head);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    track(upstream);
    client.on('data', (chunk: Buffer) => { counts.bytesUp += chunk.length; });
    upstream.on('data', (chunk: Buffer) => { counts.bytesDown += chunk.length; });
    const teardown = () => { client.destroy(); upstream.destroy(); };
    client.on('error', teardown);
    upstream.on('error', teardown);
    client.on('close', teardown);
    upstream.on('close', teardown);
  };

  const create = () => {
    const server = http.createServer(handler);
    server.on('connect', onConnect);
    server.on('connection', track);
    return server;
  };
  const listen = (server: http.Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

  const servers = [create()];
  await listen(servers[0], 0, '127.0.0.1');
  const { port } = servers[0].address() as AddressInfo;
  // Same port on the addresses WSL-hosted browsers use to reach this machine.
  for (const host of new Set(extraHosts)) {
    const server = create();
    await listen(server, port, host);
    servers.push(server);
  }

  return {
    url: `http://127.0.0.1:${port}`,
    reset: () => { counts.bytesDown = 0; counts.bytesUp = 0; },
    read: () => ({ ...counts }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}
