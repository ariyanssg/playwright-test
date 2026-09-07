import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appDataDir } from './config.js';
import { ScanService } from './service.js';
import type { ScanOptions, ScanProgressEvent } from './types.js';

export interface ServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startDashboard(service: ScanService, port = 4173): Promise<ServerHandle> {
  let boundPort = port;
  const server = createServer((request, response) => {
    void routeRequest(service, boundPort, request, response).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!response.headersSent) json(response, status, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  boundPort = actualPort;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function routeRequest(service: ScanService, port: number, request: IncomingMessage, response: ServerResponse): Promise<void> {
  setSecurityHeaders(response);
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const method = request.method ?? 'GET';

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/app.js' || url.pathname === '/styles.css')) {
    return serveStatic(url.pathname, response);
  }
  if (method === 'GET' && url.pathname === '/api/health') {
    return json(response, 200, { ok: true, service: 'Restaurant SEO 404 Auditor' });
  }
  if (method === 'GET' && url.pathname === '/api/providers/status') {
    return json(response, 200, {
      searchApi: Boolean(process.env.SEARCHAPI_API_KEY),
      dataForSeo: Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD),
      googleMaps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    });
  }
  if (method === 'GET' && url.pathname === '/api/scans') {
    return json(response, 200, { scans: service.listScans() });
  }
  if (method === 'POST' && url.pathname === '/api/scans') {
    const body = await readJson<Partial<ScanOptions>>(request);
    let scan;
    try {
      scan = service.createScan(body);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    void service.start(scan.id);
    return json(response, 202, scan);
  }
  if (method === 'POST' && url.pathname === '/api/uploads') {
    const file = await saveUpload(request, url.searchParams.get('filename') ?? 'urls.txt');
    return json(response, 201, { path: file });
  }
  if (method === 'GET' && url.pathname === '/api/auth/google/status') {
    return json(response, 200, { configured: service.google.configured(), authenticated: await service.google.authenticated() });
  }
  if (method === 'GET' && url.pathname === '/api/auth/google/start') {
    const redirectUri = `http://127.0.0.1:${port}/api/auth/google/callback`;
    const auth = service.google.beginAuth(redirectUri);
    response.writeHead(302, { location: auth.url }).end();
    return;
  }
  if (method === 'GET' && url.pathname === '/api/auth/google/callback') {
    const code = url.searchParams.get('code');
    if (!code) throw new HttpError(400, url.searchParams.get('error') || 'Google did not return an authorization code');
    if (!service.google.consumeAuthState(url.searchParams.get('state'))) throw new HttpError(400, 'Invalid Google OAuth state');
    const redirectUri = `http://127.0.0.1:${port}/api/auth/google/callback`;
    await service.google.exchangeCode(code, redirectUri);
    response.writeHead(302, { location: '/?google=connected' }).end();
    return;
  }
  if (method === 'GET' && url.pathname === '/api/google/properties') {
    return json(response, 200, { properties: await service.google.listProperties() });
  }

  const scanMatch = url.pathname.match(/^\/api\/scans\/([^/]+)(?:\/(.*))?$/);
  if (scanMatch?.[1]) {
    const scanId = decodeURIComponent(scanMatch[1]);
    const action = scanMatch[2] ?? '';
    if (!service.getScan(scanId)) return json(response, 404, { error: 'Unknown scan' });
    if (method === 'GET' && !action) return json(response, 200, await service.summary(scanId));
    if (method === 'GET' && action === 'results') {
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const limit = Math.min(1_000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
      return json(response, 200, service.results(scanId, offset, limit, url.searchParams.get('classification') ?? undefined));
    }
    if (method === 'POST' && action === 'cancel') {
      service.cancel(scanId);
      return json(response, 202, { ok: true });
    }
    if (method === 'POST' && action === 'resume') {
      void service.resume(scanId).catch(() => undefined);
      return json(response, 202, { ok: true });
    }
    if (method === 'GET' && action === 'events') return streamEvents(service, scanId, request, response);
    if (method === 'GET' && action.startsWith('artifacts/')) {
      const fileName = action.slice('artifacts/'.length);
      return serveArtifact(service, scanId, fileName, response);
    }
  }
  json(response, 404, { error: 'Not found' });
}

function streamEvents(service: ScanService, scanId: string, request: IncomingMessage, response: ServerResponse): void {
  const scan = service.getScan(scanId);
  if (!scan) return json(response, 404, { error: 'Unknown scan' });
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  send({
    scanId,
    status: scan.status,
    total: scan.total,
    processed: scan.processed,
    findings: scan.findings,
    backlinkCount: service.db.backlinkCount(scanId),
    hoursChecked: service.db.hoursCount(scanId),
    hoursMismatches: service.db.hoursMismatchCount(scanId),
    message: 'Connected',
  } satisfies ScanProgressEvent);
  const unsubscribe = service.onProgress(scanId, send);
  const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15_000);
  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  request.once('close', cleanup);
  response.once('close', cleanup);
}

async function serveArtifact(service: ScanService, scanId: string, fileName: string, response: ServerResponse): Promise<void> {
  const scan = service.getScan(scanId);
  if (!scan) return json(response, 404, { error: 'Unknown scan' });
  const allowed = new Set(['report.xlsx', 'findings.csv', 'all-urls.csv', 'backlinks.csv', 'hours.csv', 'run.json']);
  if (!allowed.has(fileName)) return json(response, 404, { error: 'Unknown artifact' });
  const filePath = join(scan.outputDir, fileName);
  const info = await stat(filePath);
  response.writeHead(200, {
    'content-type': contentType(fileName),
    'content-length': info.size,
    'content-disposition': `attachment; filename="${fileName}"`,
  });
  createReadStream(filePath).pipe(response);
}

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const fileName = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css'].includes(fileName)) return json(response, 404, { error: 'Not found' });
  const filePath = fileURLToPath(new URL(`./public/${fileName}`, import.meta.url));
  const info = await stat(filePath);
  response.writeHead(200, { 'content-type': contentType(fileName), 'content-length': info.size });
  createReadStream(filePath).pipe(response);
}

async function readJson<T>(request: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body is too large; upload a file for large URL lists');
    chunks.push(buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
}

async function saveUpload(request: IncomingMessage, rawName: string): Promise<string> {
  const extension = extname(rawName).toLowerCase();
  if (!['.txt', '.csv', '.xlsx', '.xlsm'].includes(extension)) throw new HttpError(400, 'Uploads must be TXT, CSV, or XLSX files');
  const directory = join(appDataDir(), 'uploads');
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${randomUUID()}${extension}`);
  const handle = await openFile(filePath, 'wx', 0o600);
  try {
    for await (const chunk of request) await handle.write(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return filePath;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:");
}

function contentType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extension === '.csv') return 'text/csv; charset=utf-8';
  return 'application/json; charset=utf-8';
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
