import robotsParser from 'robots-parser';

interface ParsedRobots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
  getSitemaps(): string[];
}

type RobotsParserFactory = (url: string, contents: string) => ParsedRobots;

export const AUDITOR_USER_AGENT = 'SEO404Auditor/1.0 (+local-site-audit)';

export interface RobotsInfo {
  origin: string;
  robotsUrl: string;
  status: number | null;
  sitemaps: string[];
  crawlDelayMs: number | null;
  isAllowed(url: string): boolean;
}

export class RobotsCache {
  private readonly cache = new Map<string, Promise<RobotsInfo>>();

  get(value: string): Promise<RobotsInfo> {
    const origin = new URL(value).origin;
    let pending = this.cache.get(origin);
    if (!pending) {
      pending = loadRobots(origin);
      this.cache.set(origin, pending);
    }
    return pending;
  }
}

async function loadRobots(origin: string): Promise<RobotsInfo> {
  const robotsUrl = new URL('/robots.txt', origin).href;
  try {
    const response = await fetch(robotsUrl, {
      headers: { 'user-agent': AUDITOR_USER_AGENT },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (response.status === 404 || response.status === 410) return allowAll(origin, robotsUrl, response.status);
    if (!response.ok) return allowAll(origin, robotsUrl, response.status);
    const text = await response.text();
    const parser = (robotsParser as unknown as RobotsParserFactory)(robotsUrl, text);
    const delay = parser.getCrawlDelay(AUDITOR_USER_AGENT) ?? parser.getCrawlDelay('*');
    return {
      origin,
      robotsUrl,
      status: response.status,
      sitemaps: parser.getSitemaps(),
      crawlDelayMs: typeof delay === 'number' ? delay * 1_000 : null,
      isAllowed: (url) => parser.isAllowed(url, AUDITOR_USER_AGENT) !== false,
    };
  } catch {
    return allowAll(origin, robotsUrl, null);
  }
}

function allowAll(origin: string, robotsUrl: string, status: number | null): RobotsInfo {
  return {
    origin,
    robotsUrl,
    status,
    sitemaps: [],
    crawlDelayMs: null,
    isAllowed: () => true,
  };
}
