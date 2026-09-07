/** One transport boundary shared by every workspace feature. */
export async function request(url, options = {}) {
  if (globalThis.SIGNAL404_HOSTED) return (await import('./hosted.js')).hostedRequest(url, options);
  let response;
  try { response = await fetch(url, options); } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Cannot reach the local engine. Check that the dashboard is running, then try again.');
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (response.status === 404 && url.startsWith('/api/')) {
      throw new Error('The dashboard is published, but its scanner API is unavailable. Run the Node scanner backend and configure this site to forward /api/ requests to it. A static Netlify deployment alone cannot run audits.');
    }
    throw new Error(`The scanner returned an unexpected response (HTTP ${response.status}). Check the backend connection, then try again.`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}). Please try again.`);
  return body;
}
export const scanPath = (id) => `/api/scans/${encodeURIComponent(id)}`;
export const createScan = (payload) => request('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
