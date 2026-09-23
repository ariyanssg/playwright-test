import type { Config } from '@netlify/functions';
import { hostedTask } from '../../src/hosted/tasks.js';

export default async (request: Request) => {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405, headers });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return new Response(JSON.stringify({ error: 'This endpoint is available from this dashboard only.' }), { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 1_000_000) throw new Error('This request is too large. Send one page at a time.');
    const result = await hostedTask(JSON.parse(text), (key) => Netlify.env.get(key));
    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const key of ['SERPER_API_KEY', 'SEARCHAPI_API_KEY', 'GOOGLE_MAPS_API_KEY']) { const value = Netlify.env.get(key); if (value) message = message.replaceAll(value, '[redacted]'); }
    return new Response(JSON.stringify({ error: message }), { status: 502, headers });
  }
};

export const config: Config = { path: '/api/worker', rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
