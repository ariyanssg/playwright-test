const MARKDOWN_LINK = /^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/i;

export function normalizeUrl(raw: string): string {
  let value = raw.trim().replace(/^['"]|['"]$/g, '');
  const markdown = value.match(MARKDOWN_LINK);
  if (markdown?.[1]) value = markdown[1];
  value = value.replace(/^site:/i, '');
  if (!value) throw new Error('URL is empty');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;

  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url.href;
}

export function tryNormalizeUrl(raw: string): string | null {
  try {
    return normalizeUrl(raw);
  } catch {
    return null;
  }
}

export function siteKey(value: string): string {
  return new URL(normalizeUrl(value)).hostname.replace(/^www\./i, '');
}

export function siteOrigin(value: string): string {
  const url = new URL(normalizeUrl(value));
  return url.origin;
}

export function isSameSite(left: string, right: string): boolean {
  try {
    return siteKey(left) === siteKey(right);
  } catch {
    return false;
  }
}

export function uniqueUrls(values: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const value of values) {
    const normalized = tryNormalizeUrl(value);
    if (normalized) output.add(normalized);
  }
  return [...output];
}

export function extractUrlLikeValues(text: string): string[] {
  const values: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const pieces = line.includes(',') ? line.split(',') : [line];
    for (const piece of pieces) {
      const normalized = tryNormalizeUrl(piece.trim());
      if (normalized) values.push(normalized);
    }
  }
  return uniqueUrls(values);
}
