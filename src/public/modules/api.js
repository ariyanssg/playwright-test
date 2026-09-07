/** One transport boundary shared by every workspace feature. */
export async function request(url, options = {}) {
  let response;
  try { response = await fetch(url, options); } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Cannot reach the local engine. Check that the dashboard is running, then try again.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}). Please try again.`);
  return body;
}
export const scanPath = (id) => `/api/scans/${encodeURIComponent(id)}`;
export const createScan = (payload) => request('/api/scans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
