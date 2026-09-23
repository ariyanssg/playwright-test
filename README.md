# Restaurant SEO 404 Auditor

A local-first TypeScript tool that discovers restaurant-site URLs, verifies them with Playwright Chromium, identifies definitive and suspected soft 404s, and exports polished Excel, CSV, and JSON reports.

The same durable scan engine powers both the CLI and the localhost dashboard. Jobs are stored in SQLite, so cancelled or interrupted scans can resume without rechecking completed URLs.

## What it detects

- `hard_404`: final HTTP 404 response
- `gone_410`: final HTTP 410 response
- `soft_404_suspected`: successful HTTP response whose rendered title, heading, content, or similarity to a synthetic missing-page baseline strongly indicates an error page, or a deep URL that redirects (by HTTP, script, or meta refresh) to the site's homepage. Brand names such as "404 Kitchen" are not treated as error signals, and an empty page never counts as matching an empty error template
- `redirected`, `ok`, `server_error`, `blocked`, `timeout`, and `network_error`

Soft 404s are deliberately labeled as suspected and include a confidence score plus the exact evidence used. Successful redirects are retained for review but are not treated as broken pages.

## Requirements and setup

- Node.js 24 or newer
- npm
- Chromium installed through Playwright

```bash
npm install
npx playwright install chromium
npm run build
```

Start the dashboard:

```bash
npm run serve -- --open
```

### Credentials

Copy `.env.example` to `.env` and fill in the keys you have. The CLI and dashboard load that file from the working directory at startup; anything already exported in the shell takes precedence over it, and every credential is optional. `.env` is gitignored - keep it that way.

```bash
cp .env.example .env
```

It binds only to `http://127.0.0.1:4173`. Scan records and OAuth tokens stay in the operating system's user configuration directory; generated reports default to `output/runs/<scan-id>/`.

## CLI

Scan one or more sites using imports, sitemaps, and the rendered crawler:

```bash
npm run cli -- scan \
  --site https://www.yoshidasushi.com \
  --site https://anotherrestaurant.com \
  --discover all
```

Scan an exported URL list without crawling:

```bash
npm run cli -- scan \
  --input ./urls.xlsx \
  --discover import \
  --fail-on soft
```

Supported input files are TXT, CSV, XLSX, and XLSM. CSV/XLSX import recognizes columns named `url`, `website`, `domain`, `site`, `page`, or `link`; otherwise it checks every cell for a valid HTTP(S) URL.

Other commands:

```bash
npm run cli -- list
npm run cli -- resume <scan-id>
npm run cli -- auth google
npm run cli -- serve --port 4173 --open
```

Run `npm run cli -- help` for every scan option. Website audits default to **Google results only** (`--discover google`). The homepage is a search target, not an automatically added candidate. Google discovery searches five queries, starting with each query's first page, and defaults to UK English with a total budget of 50 search pages per website. Choose `--discover all` for a combined website/search/backlink audit, or `--discover import,sitemap,crawl` for website discovery. Exact URLs and files remain uncapped and default to import-only when no websites are supplied.

The scanner defaults to ten workers, at most four active requests per host, a 250 ms host delay, and a 30-second navigation timeout. URLs are interleaved across hosts so a multi-site audit keeps every worker busy, and a page is only held open while a client-rendered shell is still changing (up to two seconds) instead of for a fixed pause. Crawl and backlink caps apply only when those sources are selected.

CLI exit codes:

- `0`: completed without findings at the selected threshold
- `1`: configuration or execution failure
- `2`: completed with findings at the selected `--fail-on hard|soft` threshold
- `3`: URL verification finished, but Google discovery was incomplete (for example, a page budget or provider failure)

## Discovery sources

### Imports

Every valid pasted, `--url`, or file-imported URL is checked. Imported URLs have no artificial count limit.

CSV and XLSX files may carry optional identity columns alongside the URL column, used only by the opening-hours comparison:

| Column header | Accepted aliases |
| --- | --- |
| `url` | `urls`, `website`, `domain`, `site`, `page`, `link` |
| `name` | `restaurant`, `restaurant name`, `business`, `business name`, `title` |
| `address` | `street address`, `location`, `full address`, `formatted address` |
| `place_id` | `placeid`, `place id`, `google place id` |

Identity columns are read only when a recognized URL header is present; a header-less file is still treated as a bare list of URLs.

### Sitemaps

Reads sitemap declarations from `robots.txt`, tries `/sitemap.xml`, follows nested indexes, and decompresses gzip sitemap files. Only same-site page URLs are added.

### Rendered crawl

Uses Chromium to discover links from rendered pages. It stays on the same apex/www site, does not follow robots-disallowed URLs, blocks heavy images/media/fonts, and stops at the configurable crawl cap.

### Google search results: API and local browser

```bash
# Default: Auto provider, UK English, 50 search pages per website
npm run cli -- scan --site https://www.seacontainerslondon.com/

# Browser discovery without a provider key
npm run cli -- scan --site https://example.com --google-provider browser

# API only, using SEARCHAPI_API_KEY from your environment or local .env
npm run cli -- scan --site https://example.com --google-provider searchapi --google-country gb --google-language en --google-max-pages 50
```

Auto uses SearchApi when `SEARCHAPI_API_KEY` is configured, otherwise a dedicated local Chromium browser. API failure switches Auto to the browser and records the reason. Explicit provider choices never silently switch. The legacy `--discover searchapi` remains API-only; `--discover all` invokes unified Google discovery once. API requests consume provider credits.

The five queries are `site:domain`, `site:domain 404`, `site:domain "not found"`, `site:domain "page does not exist"`, and `site:domain intitle:error`. Pagination stops when results end, repeat, or reach the total page budget. Only organic results and sitelinks on the target hostname or its www equivalent become Google candidates. Search links are resolved to the original destination; PDFs and meaningful query strings are preserved. Sitemaps, website links, and guessed paths never count as Google search evidence.

The browser uses its own persistent profile under the local data directory. Google searches are serialized. On a CAPTCHA or consent screen, the audit enters **Waiting for Google**. Resolve the prompt in the browser, then select **Continue** in the dashboard (or press Enter in an interactive CLI). Cancellation saves progress. Resume continues saved query/page checkpoints and completed URL checks, including after a restart. No CAPTCHA solving or bypass is automated.

Each observation retains provider, query, page, position, title, snippet, search URL, country, language, and timestamp. Coverage distinguishes exhausted results, page-budget limits, failures, and explicit empty searches. A failed search is never reported as a clean audit. Google `site:` results remain diagnostic and non-exhaustive; see [Google's limitations](https://developers.google.com/search/docs/monitor-debug/search-operators/all-search-site) and [SearchApi pagination](https://www.searchapi.io/docs/google). Google search result pages currently use pagination rather than `num=100`.

### Google Search Console

1. Create a Google Cloud OAuth client and enable the Search Console API.
2. Add these localhost redirect URIs:
   - `http://127.0.0.1:4173/api/auth/google/callback`
   - `http://127.0.0.1:4174/oauth2/callback`
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Run `npm run cli -- auth google`, or use **Connect Search Console** in the dashboard.
5. Include `gsc` in discovery. Add `--inspect-google` to inspect actionable findings.

The tool prefers matching domain properties (`sc-domain:example.com`), then the longest matching URL-prefix property. Search Analytics defaults to the last 90 available days. URL Inspection is used only for hard/soft findings and remains subject to Google quotas. Search Console data is evidence about Google's stored/indexed version, while Playwright provides the current live response.

### DataForSEO backlinks

Set the API login and API password from DataForSEO's API Access page:

```bash
export DATAFORSEO_LOGIN="your-api-login"
export DATAFORSEO_PASSWORD="your-api-password"
npm run cli -- scan --site https://example.com --discover all
```

The adapter requests live and lost backlinks in `as_is` mode, follows DataForSEO pagination tokens, records every referring URL, and adds every same-site backlink destination to the Playwright verification queue. Use `--backlink-limit` to control the provider-billed maximum. Backlink coverage describes DataForSEO's index, not a guaranteed inventory of the entire web.

## Opening hours comparison

`--check-hours` adds a stage that fetches each restaurant's Google opening hours and diffs them against the hours published on its own website.

With `GOOGLE_MAPS_API_KEY` in `.env`:

```bash
npm run cli -- scan \
  --input restaurants.csv \
  --discover import \
  --check-hours \
  --hours-tolerance 15
```

**Setup.** Enable **Places API (New)** in Google Cloud and set `GOOGLE_MAPS_API_KEY`, either in a `.env` file in the project root (copy `.env.example`) or exported in the shell. Text Search and Place Details are billed per request, and asking for opening hours puts the call in a higher-priced field tier - the stage is off by default for that reason, and issues at most one lookup per unique site.

`GOOGLE_MAPS_API_KEY` is an API key and is **not** the same credential as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, which authorize Search Console and the connected Business Profile mode. A key that exists can still be refused - an IP or HTTP-referrer restriction on the key blocks server-side calls like these, and Google reports that as HTTP 403. The dashboard shows Google's own reason in full: open **Connections -> Google Places -> Test key**, or use the **Test key** button beside the profile source in a new audit. From the shell:

```bash
curl -s -X POST http://127.0.0.1:4173/api/providers/places/check
```

**Options.**

| Flag | Default | Effect |
| --- | --- | --- |
| `--check-hours` | off | Enables the stage |
| `--hours-tolerance <minutes>` | 15 | Differences at or under this are reported as minor rather than as mismatches |
| `--hours-pages <n>` | 5 | Pages read per site when looking for hours |
| `--hours-require-verified-place` | off | Skip any site whose Google listing cannot be verified |

**Matching a restaurant to its listing.** A `place_id` column wins outright. Otherwise the restaurant's name and address come from the input file or from the site's own JSON-LD, a Text Search is issued, and a returned listing counts as **verified** only when its `websiteUri` host matches the site's. Several listings pointing at one domain are reported as **ambiguous** rather than guessed at, and a name-only match is reported as **unverified** and flagged in the workbook, the CSV, the notes, and the run warnings.

**Reading hours from the website.** Three layers, in confidence order: schema.org JSON-LD (`openingHoursSpecification` and the legacy `openingHours` shorthand, including several day groups in one value such as `Mo-Sa 11:00-23:00 Su 12:00-22:00`), microdata, then visible page text. The text reader accepts UK dotted times (`11.30am`), reads bare 12-hour ranges the way a restaurant means them (`11-10` is 11 AM to 10 PM), keeps a day whose line also mentions a closed break, and ignores ordinary words that look like day abbreviations ("We are open…"). The highest-ranked page is read first; when it already publishes a complete structured week the remaining pages are skipped, otherwise they load in parallel. The highest-confidence layer that produced anything wins outright - layers are never merged, because combining a partial specification with text guesses would invent hours that appear in neither source. A day is only compared when the source actually says something about it, so a site listing Monday to Friday is reported as `partial`, never as closed at the weekend.

**Comparing.** Both sides are local wall-clock times at the restaurant, so no timezone conversion happens; `utcOffsetMinutes` is recorded as context only. The comparison handles closes after midnight, split lunch and dinner shifts, closed days, and around-the-clock listings. Tolerance applies to each boundary independently.

**Out of scope in this version:** holiday and special hours, name/address/phone consistency, more than one location per domain (supply `place_id` per row), hours rendered inside a third-party booking widget, and non-English visible text (JSON-LD still works in any language).

A mismatch means the two published sources disagree - Google's data is crowd-edited and frequently stale, so it does not by itself mean the website is wrong.

## Reports

Each run produces:

- `report.xlsx` with `Summary`, `Broken & Soft 404`, `All URLs`, `Backlinks`, and `Sources & Run Info` sheets, plus `Hours Comparison` when `--check-hours` is used
- `findings.csv` containing hard 404, 410, and suspected soft 404 rows
- `all-urls.csv` containing every completed check
- `backlinks.csv` containing referring URLs, anchors, provider metrics, and the verified live outcome of every on-site backlink target
- `hours.csv`, written only when `--check-hours` is used, with one row per restaurant per day
- `run.json` containing the complete machine-readable job, discovery evidence, results, warnings, and per-query Google checkpoints/coverage
- Google audits include a **Google Coverage** worksheet in `report.xlsx`; result evidence is also retained in CSV and JSON

The workbook uses typed dates/numbers, filters, frozen headings, URL hyperlinks, status colors, and formula-driven summary counts. Cancelled runs still export a report marked `cancelled`; resuming replaces it with the completed report.

## Local API

The dashboard exposes a localhost-only JSON/SSE API:

- `POST /api/scans`
- `GET /api/scans` and `GET /api/scans/:id`
- `GET /api/scans/:id/events`
- `GET /api/scans/:id/results`
- `POST /api/scans/:id/cancel` and `/resume`
- `GET /api/scans/:id/artifacts/:file`
- `POST /api/uploads`
- Google OAuth status/start/callback and property-list endpoints

## Verification

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
```

The test suite uses local fixture sites for 404, 410, server- and client-rendered soft 404, redirect, robots, nested/gzip sitemap, SearchApi, opening hours in JSON-LD, microdata and plain text, cancellation/resume, report reconciliation, and dashboard download workflows. External APIs, including Google Places, are exercised against local mock servers through their endpoint overrides. The automated suite intercepts Google browser pages locally, including redirects, consent/CAPTCHA, empty results, and pagination; live Google validation is performed separately. Google Maps is accessed through Places APIs.

## Dashboard architecture

### Netlify deployment

`netlify.toml` builds with `npm run build:netlify` and publishes **`dist/public`**.
Publishing `dist` instead produces a root-page 404 because the dashboard's
`index.html` is inside its `public` subdirectory.

The hosted edition uses browser IndexedDB for audits, candidates, Google search
observations, checkpoints, and hours records. Stateless Netlify Functions run
one Google result page, rendered URL check, or hours step per request. Chromium
is bundled for the Linux serverless runtime; no separate server or paid database
is needed. Google discovery uses SearchApi only. Exact TXT/CSV/XLSX/XLSM imports
have no application row cap, and reports are generated and downloaded locally.
Website crawling, sitemaps, backlinks, local Google-browser discovery and Search
Console remain desktop features and are not advertised as hosted capabilities.

Keep the audit tab open while scanning. After a tab closes or reloads, Resume
continues from committed browser checkpoints. A request interrupted before its
response is saved may need to run again; completed checks are retained. Browser
Web Locks prevent duplicate workers for the same audit across tabs. Different
browsers, devices, or Netlify preview origins have separate histories. Clearing
site data removes audits; export reports to keep a durable copy. Browser storage
quota errors stop the run instead of silently dropping progress.

Online rendering has a 12-second navigation timeout and checks one URL at a time
to fit function limits. Public-network validation and a DNS-pinning proxy protect
every browser connection, including redirects and subresources. Worker requests
are rate-limited. API credentials remain in Netlify, not in browser storage.
Free hosting is subject to Netlify credits/limits; SearchApi and Google Places
have their own quotas and pricing. This is not unlimited free scanning.

For a linked Netlify site, import the project's local credentials before deploying:

```bash
npx netlify login
npx netlify link
npx netlify env:import .env
```

Importing `.env` sets Netlify environment variables; it does not upload the file
as a public asset. Keep `.env` ignored by Git and outside `dist/public`. The
worker reads the imported variables at runtime. Dashboard JavaScript must never
contain API keys. Run `npm run build` for the original desktop build, or
`npm run build:netlify` for the hosted edition. Deploy both `dist/public` and the
configured `netlify/functions` directory; deploying assets alone is insufficient.

The dashboard is a local, dependency-free ES module application. Its five routes
separate the overview, audit setup, findings, history, and optional connections.
An audit can be bookmarked with `/#audit-workspace?run=<scan-id>`; browser back
and forward preserve the current form and result filters.

- `src/public/app.js` composes the features and coordinates refreshes.
- `src/public/modules/api.js` owns HTTP requests and transport errors.
- `src/public/modules/router.js` owns hash routing, focus, and mobile navigation.
- `src/public/modules/workspace.js` owns history, overview totals, and activity.
- `src/public/modules/setup.js` owns input, presets, upload, validation, and submission.
- `src/public/modules/audit.js` owns scan selection, SSE/polling, results, and evidence.
- `src/public/modules/connections.js` owns provider readiness and optional features.
- `src/public/modules/ui.js` contains shared formatting and feedback primitives.
- `src/public/styles.css` holds the whole design system in one file (no import chain), with light and dark themes.
- `src/public/fonts/` bundles Archivo and Martian Mono (SIL OFL), so the dashboard makes no third-party font requests.

Search and outcome filtering run in SQLite before results are paginated into
25-row pages, ordered worst first (hard 404, gone, suspected soft 404, errors,
redirects, then healthy pages). `GET /api/scans/:id/results` accepts `search`, `classification`,
`offset`, and `limit` (1–1,000); search covers URLs, page titles, and classification
reasons. Audit history includes all saved runs. Requests from a previous scan
selection cannot overwrite the current view. Live results use SSE, with periodic
reconciliation and retry feedback if the connection drops.

The interface supports keyboard navigation, a Ctrl/⌘ K palette that jumps to any
page or recent audit, focus-managed mobile navigation, a native evidence side
sheet, reduced motion, light and dark themes, visible validation, and retryable
load failures. Live progress is painted at most once per frame, and polling
never re-renders a table whose data has not changed. The workspace regression tests cover these flows against isolated
SQLite databases, including 511 results, more than 50 audits, and layouts from
320px to 1440px. Existing fixture-site tests verify real Chromium scans,
report downloads, cancellation, and resume through the redesigned interface.
