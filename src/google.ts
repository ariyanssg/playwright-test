import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import open from 'open';
import { google, type Auth } from 'googleapis';
import { appConfigDir } from './config.js';
import type { DiscoveredUrl } from './discovery/sitemap.js';
import type { GoogleIndexEvidence } from './types.js';
import { isSameSite, normalizeUrl, siteKey } from './urls.js';

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

export interface GoogleProperty {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscDiscoveryResult {
  property: string;
  urls: DiscoveredUrl[];
  sitemapUrls: string[];
}

export class GoogleSearchConsole {
  readonly tokenPath: string;
  private readonly pendingStates = new Set<string>();

  constructor(tokenPath = join(appConfigDir(), 'google-token.json'), private readonly scopes: string[] = SCOPES, private readonly connectionName = 'Google Search Console') {
    this.tokenPath = tokenPath;
  }

  configured(): boolean {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }

  async authenticated(): Promise<boolean> {
    try {
      const tokens = JSON.parse(await readFile(this.tokenPath, 'utf8')) as Auth.Credentials;
      return this.configured() && Boolean(tokens.refresh_token || tokens.access_token);
    } catch {
      return false;
    }
  }

  createClient(redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:4174/oauth2/callback'): Auth.OAuth2Client {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required');
    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    client.on('tokens', (tokens) => void this.mergeAndSaveTokens(tokens));
    return client;
  }

  authUrl(redirectUri?: string): string {
    return this.createClient(redirectUri).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: this.scopes,
    });
  }

  beginAuth(redirectUri?: string): { url: string; state: string } {
    const state = randomUUID();
    this.pendingStates.add(state);
    const url = this.createClient(redirectUri).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: this.scopes,
      state,
    });
    return { url, state };
  }

  consumeAuthState(state: string | null): boolean {
    if (!state || !this.pendingStates.has(state)) return false;
    this.pendingStates.delete(state);
    return true;
  }

  async exchangeCode(code: string, redirectUri?: string): Promise<void> {
    const client = this.createClient(redirectUri);
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    await this.mergeAndSaveTokens(tokens);
  }

  async authenticateInteractive(port = 4174): Promise<void> {
    const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
    const auth = this.beginAuth(redirectUri);
    let timeout: NodeJS.Timeout | undefined;
    let serverClosed = false;
    const codePromise = new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth2/callback') {
          response.writeHead(404).end('Not found');
          return;
        }
        const error = url.searchParams.get('error');
        const codeValue = url.searchParams.get('code');
        const validState = this.consumeAuthState(url.searchParams.get('state'));
        if (error || !codeValue || !validState) {
          const reason = error || (!validState ? 'invalid OAuth state' : 'missing code');
          response.writeHead(400, { 'content-type': 'text/plain' }).end(`Google authorization failed: ${reason}`);
          serverClosed = true;
          server.close();
          if (timeout) clearTimeout(timeout);
          reject(new Error(error || (!validState ? 'Invalid OAuth state' : 'Google did not return an authorization code')));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end('<h1>SEO 404 Auditor connected</h1><p>You can close this tab and return to the terminal.</p>');
        serverClosed = true;
        server.close();
        if (timeout) clearTimeout(timeout);
        resolve(codeValue);
      });
      server.on('error', reject);
      server.listen(port, '127.0.0.1');
      timeout = setTimeout(() => {
        if (!serverClosed) server.close();
        reject(new Error('Google authorization timed out after 3 minutes'));
      }, 180_000).unref();
    });
    await open(auth.url);
    let code: string;
    try {
      code = await codePromise;
    } catch (error) {
      this.pendingStates.delete(auth.state);
      throw error;
    }
    await this.exchangeCode(code, redirectUri);
  }

  async client(redirectUri?: string): Promise<Auth.OAuth2Client> {
    const client = this.createClient(redirectUri);
    let raw: string;
    try {
      raw = await readFile(this.tokenPath, 'utf8');
    } catch {
      throw new Error(`${this.connectionName} is not connected`);
    }
    client.setCredentials(JSON.parse(raw));
    return client;
  }

  async listProperties(auth?: Auth.OAuth2Client): Promise<GoogleProperty[]> {
    const client = auth ?? await this.client();
    const service = google.webmasters({ version: 'v3', auth: client });
    const response = await service.sites.list();
    return (response.data.siteEntry ?? [])
      .filter((entry) => entry.siteUrl && entry.permissionLevel !== 'siteUnverifiedUser')
      .map((entry) => ({ siteUrl: entry.siteUrl!, permissionLevel: entry.permissionLevel ?? 'unknown' }));
  }

  async discover(site: string, days: number): Promise<GscDiscoveryResult> {
    const auth = await this.client();
    const property = await this.matchProperty(site, auth);
    if (!property) throw new Error(`No verified Search Console property matches ${siteKey(site)}`);
    const service = google.webmasters({ version: 'v3', auth });
    const end = new Date();
    end.setUTCDate(end.getUTCDate() - 3);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
    const urls = new Map<string, DiscoveredUrl>();
    for (let startRow = 0; ; startRow += 5_000) {
      const response = await service.searchanalytics.query({
        siteUrl: property,
        requestBody: {
          startDate: dateOnly(start),
          endDate: dateOnly(end),
          dimensions: ['page'],
          searchType: 'web',
          rowLimit: 5_000,
          startRow,
        },
      });
      const rows = response.data.rows ?? [];
      for (const row of rows) {
        const rawUrl = row.keys?.[0];
        if (!rawUrl || !isSameSite(rawUrl, site)) continue;
        const url = normalizeUrl(rawUrl);
        urls.set(url, {
          url,
          evidence: {
            source: 'gsc', property, impressions: row.impressions ?? undefined, clicks: row.clicks ?? undefined,
            averagePosition: row.position ?? undefined,
          },
        });
      }
      if (rows.length < 5_000) break;
    }
    const sitemapResponse = await service.sitemaps.list({ siteUrl: property });
    const sitemapUrls = (sitemapResponse.data.sitemap ?? []).flatMap((entry) => entry.path ? [entry.path] : []);
    return { property, urls: [...urls.values()], sitemapUrls };
  }

  async inspect(url: string): Promise<GoogleIndexEvidence> {
    const auth = await this.client();
    const property = await this.matchProperty(url, auth);
    if (!property) throw new Error(`No verified Search Console property matches ${siteKey(url)}`);
    const service = google.searchconsole({ version: 'v1', auth });
    const response = await service.urlInspection.index.inspect({
      requestBody: { inspectionUrl: normalizeUrl(url), siteUrl: property, languageCode: 'en-US' },
    });
    const status = response.data.inspectionResult?.indexStatusResult;
    return {
      property,
      verdict: status?.verdict,
      coverageState: status?.coverageState,
      indexingState: status?.indexingState,
      robotsTxtState: status?.robotsTxtState,
      pageFetchState: status?.pageFetchState,
      googleCanonical: status?.googleCanonical,
      userCanonical: status?.userCanonical,
      lastCrawlTime: status?.lastCrawlTime,
      referringUrls: status?.referringUrls ?? undefined,
    };
  }

  async matchProperty(site: string, auth?: Auth.OAuth2Client): Promise<string | null> {
    const properties = await this.listProperties(auth);
    const domainProperty = `sc-domain:${siteKey(site)}`;
    if (properties.some((property) => property.siteUrl === domainProperty)) return domainProperty;
    const target = normalizeUrl(site);
    return properties
      .filter((property) => property.siteUrl.startsWith('http') && target.startsWith(property.siteUrl))
      .sort((left, right) => right.siteUrl.length - left.siteUrl.length)[0]?.siteUrl ?? null;
  }

  private async mergeAndSaveTokens(tokens: Auth.Credentials): Promise<void> {
    let current: Auth.Credentials = {};
    try {
      current = JSON.parse(await readFile(this.tokenPath, 'utf8'));
    } catch {
      // First authentication.
    }
    const merged = { ...current, ...tokens, refresh_token: tokens.refresh_token ?? current.refresh_token };
    await mkdir(dirname(this.tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(this.tokenPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.tokenPath, 0o600);
  }
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
