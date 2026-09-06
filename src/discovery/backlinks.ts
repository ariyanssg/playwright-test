import type { BacklinkRecord, DiscoveryEvidence } from '../types.js';
import { isSameSite, normalizeUrl, siteKey, tryNormalizeUrl } from '../urls.js';

interface BacklinksApiItem {
  domain_from?: string;
  url_from?: string;
  url_to?: string;
  page_from_title?: string | null;
  page_from_status_code?: number | null;
  url_to_status_code?: number | null;
  anchor?: string | null;
  dofollow?: boolean | null;
  item_type?: string | null;
  is_new?: boolean;
  is_lost?: boolean;
  is_broken?: boolean | null;
  rank?: number | null;
  domain_from_rank?: number | null;
  backlink_spam_score?: number | null;
  first_seen?: string | null;
  last_seen?: string | null;
  links_count?: number | null;
}

interface BacklinksApiResult {
  total_count?: number;
  items_count?: number;
  items?: BacklinksApiItem[];
  search_after_token?: string | null;
}

interface BacklinksApiResponse {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    result?: BacklinksApiResult[];
  }>;
}

export interface BacklinkDiscoveryResult {
  backlinks: BacklinkRecord[];
  candidates: Array<{ url: string; evidence: DiscoveryEvidence }>;
  totalAvailable: number;
  fetched: number;
  costUsd: number;
  truncated: boolean;
  coverageNote: string;
}

export async function discoverBacklinks(
  site: string,
  limit: number,
  login = process.env.DATAFORSEO_LOGIN,
  password = process.env.DATAFORSEO_PASSWORD,
): Promise<BacklinkDiscoveryResult> {
  if (!login || !password) {
    throw new Error('DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are required for backlink discovery');
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error('backlink limit must be a positive integer');

  const endpoint = process.env.DATAFORSEO_BACKLINKS_ENDPOINT
    || 'https://api.dataforseo.com/v3/backlinks/backlinks/live';
  const pageSize = Math.min(1_000, limit);
  const target = siteKey(site);
  const backlinks: BacklinkRecord[] = [];
  const candidateMap = new Map<string, { url: string; evidence: DiscoveryEvidence }>();
  const seenBacklinks = new Set<string>();
  const seenTokens = new Set<string>();
  let searchAfterToken: string | null = null;
  let offset = 0;
  let totalAvailable = 0;
  let costUsd = 0;

  while (backlinks.length < limit) {
    const task: Record<string, unknown> = {
      target,
      mode: 'as_is',
      limit: pageSize,
      backlinks_status_type: 'all',
      include_subdomains: true,
      exclude_internal_backlinks: true,
      rank_scale: 'one_hundred',
    };
    if (searchAfterToken) task.search_after_token = searchAfterToken;
    else if (offset > 0) task.offset = offset;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify([task]),
    });
    const payload = await readPayload(response);
    if (!response.ok) throw new Error(providerError(payload, `HTTP ${response.status}`));
    if (payload.status_code !== 20_000) throw new Error(providerError(payload, 'DataForSEO request failed'));
    const apiTask = payload.tasks?.[0];
    if (!apiTask || apiTask.status_code !== 20_000) {
      throw new Error(apiTask?.status_message || 'DataForSEO backlink task failed');
    }
    const result = apiTask.result?.[0];
    if (!result) break;
    totalAvailable = Math.max(totalAvailable, result.total_count ?? 0);
    costUsd += payload.cost ?? 0;

    const items = result.items ?? [];
    for (const item of items) {
      if (backlinks.length >= limit) break;
      const sourceUrl = item.url_from ? tryNormalizeUrl(item.url_from) : null;
      const targetUrl = item.url_to ? tryNormalizeUrl(item.url_to) : null;
      if (!sourceUrl || !targetUrl || !isSameSite(site, targetUrl)) continue;
      const key = `${sourceUrl}\n${targetUrl}\n${item.anchor ?? ''}`;
      if (seenBacklinks.has(key)) continue;
      seenBacklinks.add(key);

      const backlink: BacklinkRecord = {
        site: normalizeUrl(site),
        targetUrl,
        sourceUrl,
        sourceDomain: item.domain_from || new URL(sourceUrl).hostname,
        sourceTitle: item.page_from_title ?? null,
        sourceHttpStatus: item.page_from_status_code ?? null,
        targetProviderStatus: item.url_to_status_code ?? null,
        anchor: item.anchor ?? null,
        dofollow: item.dofollow ?? null,
        linkType: item.item_type ?? null,
        isNew: Boolean(item.is_new),
        isLost: Boolean(item.is_lost),
        isBrokenByProvider: item.is_broken ?? null,
        rank: item.rank ?? null,
        domainRank: item.domain_from_rank ?? null,
        spamScore: item.backlink_spam_score ?? null,
        firstSeen: item.first_seen ?? null,
        lastSeen: item.last_seen ?? null,
        linksCount: item.links_count ?? 1,
        provider: 'dataforseo',
      };
      backlinks.push(backlink);
      const normalizedTarget = normalizeUrl(targetUrl);
      if (!candidateMap.has(normalizedTarget)) {
        candidateMap.set(normalizedTarget, {
          url: normalizedTarget,
          evidence: {
            source: 'backlinks',
            provider: 'dataforseo',
            discoveredFrom: sourceUrl,
            backlinkSourceUrl: sourceUrl,
            backlinkSourceDomain: backlink.sourceDomain,
            anchor: backlink.anchor,
            dofollow: backlink.dofollow ?? undefined,
          },
        });
      }
    }

    if (!items.length || backlinks.length >= limit || (totalAvailable > 0 && backlinks.length >= totalAvailable)) break;
    const nextToken = result.search_after_token ?? null;
    if (nextToken) {
      if (seenTokens.has(nextToken)) break;
      seenTokens.add(nextToken);
      searchAfterToken = nextToken;
    } else {
      offset += pageSize;
      if (offset > 20_000) break;
    }
  }

  const truncated = totalAvailable > backlinks.length;
  return {
    backlinks,
    candidates: [...candidateMap.values()],
    totalAvailable,
    fetched: backlinks.length,
    costUsd,
    truncated,
    coverageNote: truncated
      ? `DataForSEO returned ${backlinks.length.toLocaleString()} of ${totalAvailable.toLocaleString()} backlink records because the configured limit is ${limit.toLocaleString()}.`
      : `DataForSEO returned ${backlinks.length.toLocaleString()} backlink records from its backlink index; provider coverage is not the entire web.`,
  };
}

async function readPayload(response: Response): Promise<BacklinksApiResponse> {
  try {
    return await response.json() as BacklinksApiResponse;
  } catch {
    return { status_message: `DataForSEO returned a non-JSON response (HTTP ${response.status})` };
  }
}

function providerError(payload: BacklinksApiResponse, fallback: string): string {
  return payload.status_message || payload.tasks?.[0]?.status_message || fallback;
}
