import type { Config } from '@netlify/functions';
import { HostedInputError, hostedTask } from '../../src/hosted/tasks.js';

export default async (request: Request) => {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405, headers });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response(JSON.stringify({ error: 'This endpoint is available from this dashboard only.' }), { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 1_000_000) throw new HostedInputError('This request is too large. Send one page at a time.');
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new HostedInputError('This request is not valid JSON.'); }
    const result = await hostedTask(body, (key) => Netlify.env.get(key));
    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const key of ['SERPER_API_KEY', 'SEARCHAPI_API_KEY', 'GOOGLE_MAPS_API_KEY', 'DATAFORSEO_PASSWORD']) { const value = Netlify.env.get(key); if (value) message = message.replaceAll(value, '[redacted]'); }
    // 400: the request itself is wrong and retrying cannot help. 503: a provider, the network or
    // the browser failed this time; the dashboard waits and tries again.
    const refused = error instanceof HostedInputError;
    return new Response(JSON.stringify({ error: message, retryable: !refused }), { status: refused ? 400 : 503, headers });
  }
};

// Each call now carries a batch of pages, so a busy audit makes far fewer calls than before; the
// limit only has to stop abuse, and the dashboard backs off when it is reached.
export const config: Config = { path: '/api/worker', rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
