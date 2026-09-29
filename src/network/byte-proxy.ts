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
  /** Clears the byte counts and the upstream errors. */
  reset(): void;
  read(): ByteCounts;
  /** Upstream connections the proxy could not open since reset(), as "host:port CODE". */
  errors(): string[];
  close(): Promise<void>;
}

/**
 * Node's happy eyeballs gives each address 250 ms by default, then abandons it for the next one, where
 * browsers keep the first attempt racing. Without IPv6 (WSL's NAT), a busy machine then lost ~0.5% of
 * tunnels once both IPv4 attempts were cut short: the browser got an empty response and the run failed.
 */
const ATTEMPT_TIMEOUT_MS = 2_000;

function errorCode(err: Error & { code?: string; errors?: Array<{ code?: string }> }): string {
  return err.code || err.errors?.map((e) => e.code).filter(Boolean).join('+') || err.message;
}

/** "host:port" of a CONNECT request, IPv6 literals included ("[::1]:443"). */
export function connectTarget(authority: string): { host: string; port: number } | null {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/i.exec(authority);
  if (!match) return null;
  return { host: match[1].replace(/^\[(.*)\]$/, '$1'), port: match[2] ? Number(match[2]) : 443 };
}

const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade']);

export async function startByteProxy(extraHosts: string[] = []): Promise<ByteProxy> {
  // Process-wide: the proxy is the only thing here connecting to host names (drivers use IP literals).
  net.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_TIMEOUT_MS);
  const counts: ByteCounts = { bytesDown: 0, bytesUp: 0 };
  const upstreamErrors: string[] = [];
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
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        upstreamErrors.push(`${target.host} ${errorCode(err)}`);
        res.writeHead(502);
      }
      res.end();
    });
    req.on('data', (chunk: Buffer) => { counts.bytesUp += chunk.length; });
    req.pipe(upstream);
  };

  const onConnect = (req: http.IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    const target = connectTarget(req.url ?? '');
    if (!target) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let established = false;
    const upstream = net.connect(target.port, target.host, () => {
      established = true;
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
    client.on('close', teardown);
    upstream.on('error', (err) => {
      if (established) return teardown();
      // Answer the CONNECT, as a real proxy would: closing on the browser reads as an empty response.
      upstreamErrors.push(`${req.url} ${errorCode(err)}`);
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    upstream.on('close', () => { if (established) teardown(); });
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
    reset: () => { counts.bytesDown = 0; counts.bytesUp = 0; upstreamErrors.length = 0; },
    read: () => ({ ...counts }),
    errors: () => [...upstreamErrors],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}
