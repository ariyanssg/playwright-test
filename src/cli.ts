#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface, type Interface } from 'node:readline';
import open from 'open';
import { DISCOVERY_SOURCES, type DiscoverySource, type ScanOptions, type StoredScan } from './types.js';
import { ScanService } from './service.js';
import { startDashboard } from './server.js';

// Credentials may live in a .env file beside the project. Variables already exported
// in the shell take precedence, matching how Node's own --env-file behaves.
try {
  process.loadEnvFile();
} catch {
  // No .env file is the normal case when credentials are exported directly.
}

const [command = 'help', ...rest] = process.argv.slice(2);

try {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
  } else if (command === 'scan') {
    await scan(rest);
  } else if (command === 'resume') {
    await resume(rest);
  } else if (command === 'serve') {
    await serve(rest);
  } else if (command === 'auth' && rest[0] === 'google') {
    await authGoogle(rest.slice(1));
  } else if (command === 'list') {
    await list();
  } else {
    throw new Error(`Unknown command: ${[command, ...rest].join(' ')}`);
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function scan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      site: { type: 'string', multiple: true },
      url: { type: 'string', multiple: true },
      input: { type: 'string', multiple: true },
      discover: { type: 'string' },
      'google-provider': { type: 'string', default: 'auto' },
      'google-country': { type: 'string', default: 'gb' },
      'google-language': { type: 'string', default: 'en' },
      'google-max-pages': { type: 'string', default: '50' },
      output: { type: 'string' },
      concurrency: { type: 'string', default: '5' },
      'per-host': { type: 'string', default: '2' },
      'host-delay': { type: 'string', default: '300' },
      'crawl-limit': { type: 'string', default: '10000' },
      timeout: { type: 'string', default: '30000' },
      'inspect-google': { type: 'boolean', default: false },
      'gsc-days': { type: 'string', default: '90' },
      'backlink-limit': { type: 'string', default: '100000' },
      'fail-on': { type: 'string', default: 'hard' },
      'check-hours': { type: 'boolean', default: false },
      'hours-tolerance': { type: 'string', default: '15' },
      'hours-pages': { type: 'string', default: '5' },
      'hours-require-verified-place': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });
  if (values.help) return printHelp();
  const service = new ScanService();
  try {
    const options: Partial<ScanOptions> = {
      sites: values.site ?? [],
      urls: values.url ?? [],
      inputFiles: values.input ?? [],
      discovery: values.discover ? parseDiscovery(values.discover) : undefined,
      googleProvider: values['google-provider'] as ScanOptions['googleProvider'],
      googleCountry: values['google-country'],
      googleLanguage: values['google-language'],
      googleMaxPages: numberOption(values['google-max-pages'], 'Google page budget'),
      outputDir: values.output,
      concurrency: numberOption(values.concurrency, 'concurrency'),
      perHostConcurrency: numberOption(values['per-host'], 'per-host'),
      hostDelayMs: numberOption(values['host-delay'], 'host-delay'),
      crawlLimit: numberOption(values['crawl-limit'], 'crawl-limit'),
      timeoutMs: numberOption(values.timeout, 'timeout'),
      inspectGoogle: values['inspect-google'],
      gscDays: numberOption(values['gsc-days'], 'gsc-days'),
      backlinkLimit: numberOption(values['backlink-limit'], 'backlink-limit'),
      failOn: parseFailOn(values['fail-on']),
      checkHours: values['check-hours'],
      hoursToleranceMinutes: numberOption(values['hours-tolerance'], 'hours-tolerance'),
      hoursPageLimit: numberOption(values['hours-pages'], 'hours-pages'),
      hoursRequireVerifiedPlace: values['hours-require-verified-place'],
    };
    const created = service.createScan(options);
    console.log(`Scan ${created.id}`);
    const unsubscribe = watchProgress(service, created.id);
    const completed = await service.start(created.id);
    unsubscribe();
    console.log(`Status: ${completed.status}`);
    console.log(`Report: ${completed.outputDir}/report.xlsx`);
    if (completed.error) throw new Error(completed.error);
    if (completed.status === 'completed_partial') process.exitCode = 3;
    else if (meetsFailureThreshold(service, completed)) process.exitCode = 2;
  } finally {
    service.close();
  }
}

async function resume(args: string[]): Promise<void> {
  const scanId = args[0];
  if (!scanId) throw new Error('Usage: seo404 resume <scan-id>');
  const service = new ScanService();
  try {
    const unsubscribe = watchProgress(service, scanId);
    const completed = await service.resume(scanId);
    unsubscribe();
    console.log(`Status: ${completed.status}`);
    console.log(`Report: ${completed.outputDir}/report.xlsx`);
    if (completed.error) throw new Error(completed.error);
    if (completed.status === 'completed_partial') process.exitCode = 3;
    else if (meetsFailureThreshold(service, completed)) process.exitCode = 2;
  } finally {
    service.close();
  }
}

async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { port: { type: 'string', default: '4173' }, open: { type: 'boolean', default: false } } });
  const service = new ScanService();
  const dashboard = await startDashboard(service, numberOption(values.port, 'port'));
  console.log(`Dashboard: ${dashboard.url}`);
  if (values.open) await open(dashboard.url);
  const shutdown = async () => {
    await dashboard.close();
    service.close();
  };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  await new Promise(() => undefined);
}

async function authGoogle(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { port: { type: 'string', default: '4174' } } });
  const service = new ScanService();
  try {
    await service.google.authenticateInteractive(numberOption(values.port, 'port'));
    console.log('Google Search Console connected.');
  } finally {
    service.close();
  }
}

async function list(): Promise<void> {
  const service = new ScanService();
  try {
    const scans = service.listScans();
    if (!scans.length) return console.log('No scans yet.');
    for (const scan of scans) console.log(`${scan.id}\t${scan.status}\t${scan.processed}/${scan.total}\t${scan.outputDir}`);
  } finally {
    service.close();
  }
}

function parseDiscovery(value: string | undefined): DiscoverySource[] {
  if ((value ?? '').trim().toLowerCase() === 'all') return ['import', 'sitemap', 'crawl', 'google', 'gsc', 'backlinks'];
  const sources = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const source of sources) {
    if (!DISCOVERY_SOURCES.includes(source as DiscoverySource)) throw new Error(`Unknown discovery source: ${source}`);
  }
  return [...new Set(sources)] as DiscoverySource[];
}

function parseFailOn(value: string | undefined): ScanOptions['failOn'] {
  if (value === 'hard' || value === 'soft' || value === 'none') return value;
  throw new Error('--fail-on must be hard, soft, or none');
}

function numberOption(value: string | undefined, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`--${label} must be a non-negative integer`);
  return number;
}

function printProgress(event: { processed: number; total: number; findings: number; message: string }): void {
  console.log(`[${event.processed}/${event.total}; ${event.findings} findings] ${event.message}`);
}

function watchProgress(service: ScanService, scanId: string): () => void {
  let prompt: Interface | undefined;
  const unsubscribe = service.onProgress(scanId, (event) => {
    printProgress(event);
    if (event.status === 'waiting_for_google' && process.stdin.isTTY && !prompt) {
      prompt = createInterface({ input: process.stdin, output: process.stdout });
      prompt.question('After resolving the Google prompt, press Enter to continue: ', () => {
        prompt?.close(); prompt = undefined;
        void service.resume(scanId).catch((error) => console.error(error.message));
      });
    }
  });
  return () => { prompt?.close(); unsubscribe(); };
}

function meetsFailureThreshold(service: ScanService, scan: StoredScan): boolean {
  const threshold = scan.options.failOn;
  if (threshold === 'none') return false;
  return service.results(scan.id, 0, Number.MAX_SAFE_INTEGER).items.some((candidate) => {
    const value = candidate.result?.classification;
    if (!value) return false;
    if (threshold === 'soft') return ['hard_404', 'gone_410', 'soft_404_suspected'].includes(value);
    return value === 'hard_404' || value === 'gone_410';
  });
}

function printHelp(): void {
  console.log(`Restaurant SEO 404 Auditor

Usage:
  seo404 scan --site https://example.com [options]
  seo404 scan --input urls.csv --discover import [options]
  seo404 resume <scan-id>
  seo404 serve [--port 4173] [--open]
  seo404 auth google [--port 4174]
  seo404 list

Scan options:
  --site <url>          Site to discover and scan; repeatable
  --url <url>           Exact URL to scan; repeatable
  --input <file>        TXT, CSV, or XLSX file; repeatable
  --discover <sources>  google, all, or import,sitemap,crawl,searchapi,gsc,backlinks
                       Default: google for websites; import for exact URLs/files
  --google-provider    auto, searchapi, browser (default: auto)
  --google-country     Google market code (default: gb)
  --google-language    Google language code (default: en)
  --google-max-pages   Total search pages per site (default: 50)
  --output <directory>  Output root (default: output/runs)
  --concurrency <n>     Global browser workers (default: 5)
  --per-host <n>        Per-host workers (default: 2)
  --host-delay <ms>     Delay between host requests (default: 300)
  --crawl-limit <n>     Per-site crawl cap (default: 10000)
  --timeout <ms>        Navigation timeout (default: 30000)
  --inspect-google      Inspect actionable findings in Search Console
  --gsc-days <n>        Search Analytics window (default: 90)
  --backlink-limit <n>  DataForSEO backlink row cap per site (default: 100000)
  --fail-on <level>     hard, soft, or none (default: hard)
                       Exit codes: 1 failure, 2 findings, 3 incomplete discovery

Opening hours comparison (requires GOOGLE_MAPS_API_KEY; Places API is billed per request):
  --check-hours                   Compare Google and website opening hours per site
  --hours-tolerance <minutes>     Differences at or under this are minor (default: 15)
  --hours-pages <n>               Pages inspected per site for hours (default: 5)
  --hours-require-verified-place  Skip sites whose Google listing cannot be verified
`);
}
