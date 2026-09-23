import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

/**
 * Deterministic pages served on 127.0.0.1, addressed as local://<page>?params in targets.json.
 * Same bytes for every browser and run, which isolates one variable at a time (JS weight, image
 * count...) and makes DOM-hash fidelity comparisons meaningful.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Gradient + seeded noise: real decode work, not trivially compressible. */
function generatePng(size: number, seed: number): Buffer {
  let state = seed * 2654435761 + 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  };
  const rowLength = size * 3 + 1;
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * rowLength + 1 + x * 3;
      raw[i] = ((x * 255) / size + random() / 4) & 0xff;
      raw[i + 1] = ((y * 255) / size + random() / 4) & 0xff;
      raw[i + 2] = (seed * 37 + random() / 2) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function generateHeavyJs(kb: number): string {
  const parts = ['(function(){var F=[];'];
  let size = parts[0].length;
  let i = 0;
  while (size < kb * 1024) {
    const fn = `F.push(function(){var s=0;for(var k=0;k<300;k++){s=(s+k*${(i % 97) + 1})%1000003;}var d=document.createElement("div");d.className="c${i % 10}";d.textContent="f${i}:"+s;return d;});`;
    parts.push(fn);
    size += fn.length;
    i++;
  }
  parts.push('var root=document.getElementById("root"),frag=document.createDocumentFragment();for(var j=0;j<F.length;j++)frag.appendChild(F[j]());root.appendChild(frag);document.title="heavy-js ready";})();');
  return parts.join('\n');
}

function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}.grid img{width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>${head}</head><body>${body}</body></html>`;
}

const PAGES: Record<string, (params: URLSearchParams) => string> = {
  static: () => {
    const rows = Array.from({ length: 50 }, (_, i) => `<tr><td>${i}</td><td>Row ${i}</td><td>${(i * 7919) % 1000}</td></tr>`).join('');
    const paragraphs = Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i}: the quick brown fox jumps over the lazy dog.</p>`).join('');
    return page('static fixture', `<h1>Static fixture</h1>${paragraphs}<table><tr><th>#</th><th>Name</th><th>Value</th></tr>${rows}</table>`);
  },
  'heavy-js': (params) => {
    const kb = Math.min(Number(params.get('kb') ?? 1000), 20_000);
    return page('heavy-js loading', `<h1>Heavy JS fixture (${kb} KB)</h1><div id="root"></div><script src="/assets/heavy.js?kb=${kb}"></script>`);
  },
  images: (params) => {
    const count = Math.min(Number(params.get('count') ?? 100), 2000);
    const size = Math.min(Number(params.get('size') ?? 256), 2048);
    const imgs = Array.from({ length: count }, (_, i) => `<img src="/assets/img/${i}.png?size=${size}" width="${size}" height="${size}" alt="">`).join('');
    return page('images fixture', `<h1>Images fixture (${count} x ${size}px)</h1><div class="grid">${imgs}</div>`);
  },
  spa: (params) => {
    const items = Math.min(Number(params.get('items') ?? 500), 20_000);
    const script = `<script>
fetch('/api/items?n=${items}').then(function(r){return r.json();}).then(function(data){
  var table=document.createElement('table');
  data.forEach(function(item){
    var tr=document.createElement('tr');
    [item.id,item.name,item.price.toFixed(2),item.tags.join(', ')].forEach(function(v){var td=document.createElement('td');td.textContent=v;tr.appendChild(td);});
    table.appendChild(tr);
  });
  document.getElementById('app').replaceChildren(table);
  document.title='spa ready';
});
</script>`;
    return page('spa loading', `<h1>SPA fixture</h1><div id="app">Loading...</div>${script}`);
  },
};

export interface FixtureServer {
  resolve(url: string): string;
  close(): Promise<void>;
}

/**
 * Always listens on 127.0.0.1; `extraHosts` adds listeners on the same port for browsers that
 * cannot see this machine's loopback (WSL2 reaches Windows through its gateway address).
 */
export async function startFixtureServer(extraHosts: string[] = []): Promise<FixtureServer> {
  const pngCache = new Map<string, Buffer>();
  const jsCache = new Map<number, string>();

  const handler: http.RequestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };

    const imageMatch = /^\/assets\/img\/(\d+)\.png$/.exec(url.pathname);
    if (imageMatch) {
      const size = Math.min(Number(url.searchParams.get('size') ?? 256), 2048);
      const key = `${imageMatch[1]}:${size}`;
      if (!pngCache.has(key)) pngCache.set(key, generatePng(size, Number(imageMatch[1]) + 1));
      return send(200, 'image/png', pngCache.get(key)!);
    }
    if (url.pathname === '/assets/heavy.js') {
      const kb = Math.min(Number(url.searchParams.get('kb') ?? 1000), 20_000);
      if (!jsCache.has(kb)) jsCache.set(kb, generateHeavyJs(kb));
      return send(200, 'text/javascript', jsCache.get(kb)!);
    }
    if (url.pathname === '/api/items') {
      const n = Math.min(Number(url.searchParams.get('n') ?? 500), 20_000);
      const items = Array.from({ length: n }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        price: ((i * 7919) % 10_000) / 100,
        tags: [`t${i % 7}`, `t${i % 11}`],
      }));
      return send(200, 'application/json', JSON.stringify(items));
    }
    const render = PAGES[url.pathname.slice(1)];
    if (render) return send(200, 'text/html; charset=utf-8', render(url.searchParams));
    send(404, 'text/plain', 'not found');
  };

  const listen = (server: http.Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });

  const servers = [http.createServer(handler)];
  await listen(servers[0], 0, '127.0.0.1');
  const { port } = servers[0].address() as AddressInfo;
  for (const host of new Set(extraHosts)) {
    const server = http.createServer(handler);
    await listen(server, port, host);
    servers.push(server);
  }

  return {
    resolve: (targetUrl) => targetUrl.replace(/^local:\/\//, `http://127.0.0.1:${port}/`),
    close: () =>
      Promise.all(servers.map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }))).then(() => undefined),
  };
}
