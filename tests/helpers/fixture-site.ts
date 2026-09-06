import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';

export interface FixtureSite {
  origin: string;
  requestCount(pathname: string): number;
  pacedRequestTimes(): number[];
  maxConcurrentPacedRequests(): number;
  close(): Promise<void>;
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const requests = new Map<string, number>();
  const pacedTimes: number[] = [];
  let activePaced = 0;
  let maxActivePaced = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
    const origin = `http://${request.headers.host}`;
    if (url.pathname === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`User-agent: *\nDisallow: /private\nSitemap: ${origin}/sitemap.xml\n`);
      return;
    }
    if (url.pathname === '/sitemap.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<?xml version="1.0"?><urlset><url><loc>${origin}/ok</loc></url><url><loc>${origin}/hard</loc></url></urlset>`);
      return;
    }
    if (url.pathname === '/sitemap-index.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/nested.xml.gz</loc></sitemap></sitemapindex>`);
      return;
    }
    if (url.pathname === '/nested.xml.gz') {
      const xml = `<?xml version="1.0"?><urlset><url><loc>${origin}/gone</loc></url><url><loc>https://external.example/ignored</loc></url></urlset>`;
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end(gzipSync(xml));
      return;
    }
    if (url.pathname === '/') return restaurantHome(response);
    if (url.pathname === '/ok') return html(response, 200, 'Dinner menu', '<h1>Dinner menu</h1><main>Sushi, sashimi, soups, and seasonal dishes are available tonight.</main>');
    if (url.pathname === '/hard') return html(response, 404, 'Page not found', '<h1>404 — Page not found</h1><main>The page does not exist.</main>');
    if (url.pathname === '/gone') return html(response, 410, 'Gone', '<h1>410 Gone</h1><main>This menu has been permanently removed.</main>');
    if (url.pathname === '/soft') return html(response, 200, 'Page not found', '<h1>Page not found</h1><main>Sorry, this page does not exist. Return to our restaurant home page.</main>');
    if (url.pathname === '/js-soft') {
      return html(response, 200, 'Loading', '<h1>Loading</h1><main id="main">Please wait</main><script>setTimeout(() => { document.title = "404 — Page not found"; document.querySelector("h1").textContent = "Page not found"; document.querySelector("#main").textContent = "This page does not exist"; }, 400)</script>');
    }
    if (url.pathname === '/redirect') {
      response.writeHead(301, { location: '/ok' }).end();
      return;
    }
    if (url.pathname === '/redirect-chain-a') {
      response.writeHead(301, { location: '/redirect-chain-b' }).end();
      return;
    }
    if (url.pathname === '/redirect-chain-b') {
      response.writeHead(302, { location: '/ok' }).end();
      return;
    }
    if (url.pathname === '/loop-a') {
      response.writeHead(302, { location: '/loop-b' }).end();
      return;
    }
    if (url.pathname === '/loop-b') {
      response.writeHead(302, { location: '/loop-a' }).end();
      return;
    }
    if (url.pathname === '/incidental') return html(response, 200, 'Our story', '<h1>Our story</h1><main>We have not found a better way to serve local fish, and our dining room remains open every evening.</main>');
    if (url.pathname === '/blocked') return html(response, 403, 'Forbidden', '<h1>Forbidden</h1>');
    if (url.pathname === '/server-error') return html(response, 503, 'Unavailable', '<h1>Service unavailable</h1>');
    if (url.pathname === '/retry-429') {
      if ((requests.get(url.pathname) ?? 0) === 1) return html(response, 429, 'Slow down', '<h1>Too many requests</h1>', { 'retry-after': '0' });
      return html(response, 200, 'Recovered', '<h1>Recovered after rate limit</h1><main>Dinner service is available.</main>');
    }
    if (url.pathname === '/retry-500') {
      if ((requests.get(url.pathname) ?? 0) === 1) return html(response, 503, 'Temporary error', '<h1>Temporary error</h1>');
      return html(response, 200, 'Recovered', '<h1>Recovered after server error</h1><main>Dinner service is available.</main>');
    }
    if (url.pathname === '/slow') {
      setTimeout(() => html(response, 200, 'Slow page', '<h1>Slow page</h1>'), 1_000);
      return;
    }
    if (url.pathname === '/paced') {
      pacedTimes.push(Date.now());
      activePaced += 1;
      maxActivePaced = Math.max(maxActivePaced, activePaced);
      setTimeout(() => {
        activePaced -= 1;
        html(response, 200, 'Paced page', '<h1>Paced page</h1><main>Restaurant pacing fixture content.</main>');
      }, 150);
      return;
    }
    return restaurantHome(response);
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requestCount: (pathname) => requests.get(pathname) ?? 0,
    pacedRequestTimes: () => [...pacedTimes],
    maxConcurrentPacedRequests: () => maxActivePaced,
    close: () => close(server),
  };
}

function restaurantHome(response: import('node:http').ServerResponse): void {
  html(response, 200, 'Restaurant home', '<h1>Welcome</h1><main><p>Seasonal dinner service and restaurant reservations are available every evening.</p> <a href="/ok">Menu</a> <a href="/hard">Old menu</a> <a href="/soft">Old event</a> <a href="/private">Private</a></main>');
}

function html(response: import('node:http').ServerResponse, status: number, title: string, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  response.end(`<!doctype html><html><head><title>${title}</title><link rel="canonical" href="/canonical"></head><body>${body}</body></html>`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
