import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import ipaddr from 'ipaddr.js';

export function publicUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP/HTTPS websites on ports 80/443 can be audited online.');
  return url;
}

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export async function publicAddress(host: string): Promise<string> {
  const addresses = await lookup(host.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Private, local, or reserved network addresses cannot be audited online.');
  return addresses[0]!.address;
}

// All Chromium traffic, including subresources and redirected requests, passes
// this proxy. Connections use the validated IP, avoiding DNS rebinding between
// validation and connection. No credentials or local network access are exposed.
export async function startPublicProxy() {
  const sockets = new Set<Socket>();
  const remember = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(20_000, () => socket.destroy()); };
  const server = createServer(async (req, res) => {
    try {
      const url = publicUrl(req.url || '');
      if (url.protocol !== 'http:') throw new Error('Use a TLS tunnel for HTTPS.');
      const ip = await publicAddress(url.hostname);
      const upstream = httpRequest({ hostname: ip, port: Number(url.port) || 80, path: url.pathname + url.search, method: req.method, headers: { ...req.headers, host: url.host }, timeout: 20_000 }, (reply) => {
        res.writeHead(reply.statusCode || 502, reply.headers); reply.pipe(res);
      });
      upstream.on('socket', remember); upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
    } catch { res.writeHead(403).end('Public websites only'); }
  });
  server.on('connection', remember);
  server.on('connect', async (req, client, head) => {
    try {
      const url = publicUrl(`https://${req.url}`);
      const ip = await publicAddress(url.hostname);
      const upstream = connect({ host: ip, port: Number(url.port) || 443 }); remember(upstream);
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
      upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start browser network guard');
  return { server: `http://127.0.0.1:${address.port}`, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
