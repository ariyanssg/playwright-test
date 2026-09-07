# Restaurant SEO 404 Auditor

A local-first TypeScript tool that discovers restaurant-site URLs, verifies them with Playwright Chromium, identifies definitive and suspected soft 404s, and exports polished Excel, CSV, and JSON reports.

The same durable scan engine powers both the CLI and the localhost dashboard. Jobs are stored in SQLite, so cancelled or interrupted scans can resume without rechecking completed URLs.

## What it detects

- `hard_404`: final HTTP 404 response
- `gone_410`: final HTTP 410 response
- `soft_404_suspected`: successful HTTP response whose rendered title, heading, content, or similarity to a synthetic missing-page baseline strongly indicates an error page
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

Run `npm run cli -- help` for every scan option. A submitted restaurant domain defaults to `--discover all`, which combines imports, sitemaps, rendered crawling, Google `site:` results, Search Console, and backlink evidence. Credential-dependent adapters add a visible warning and the local scan continues when they are not configured. The scanner defaults to five workers, at most two active requests per host, a 300 ms host delay, a 30-second navigation timeout, a 10,000-page crawl cap, and a 100,000-row backlink cap per site.

CLI exit codes:

- `0`: completed without findings at the selected threshold
- `1`: configuration or execution failure
- `2`: completed with findings at the selected `--fail-on hard|soft` threshold

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

### SearchApi Google `site:` results

Set `SEARCHAPI_API_KEY`, then include `searchapi`:

```bash
export SEARCHAPI_API_KEY="your-key"
npm run cli -- scan --site https://example.com --discover import,searchapi
```

The adapter records result position, title, snippet, and query. SearchApi coverage is capped at 100 results, and Google `site:` results are not a complete index inventory; the report states this limitation.

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

```bash
GOOGLE_MAPS_API_KEY=... npm run cli -- scan \
  --input restaurants.csv \
  --discover import \
  --check-hours \
  --hours-tolerance 15
```

**Setup.** Enable **Places API (New)** in Google Cloud and export `GOOGLE_MAPS_API_KEY`. Nothing in this project loads a `.env` file, so the variable must be exported in the shell. Text Search and Place Details are billed per request, and asking for opening hours puts the call in a higher-priced field tier - the stage is off by default for that reason, and issues at most one lookup per unique site.

**Options.**

| Flag | Default | Effect |
| --- | --- | --- |
| `--check-hours` | off | Enables the stage |
| `--hours-tolerance <minutes>` | 15 | Differences at or under this are reported as minor rather than as mismatches |
| `--hours-pages <n>` | 5 | Pages read per site when looking for hours |
| `--hours-require-verified-place` | off | Skip any site whose Google listing cannot be verified |

**Matching a restaurant to its listing.** A `place_id` column wins outright. Otherwise the restaurant's name and address come from the input file or from the site's own JSON-LD, a Text Search is issued, and a returned listing counts as **verified** only when its `websiteUri` host matches the site's. Several listings pointing at one domain are reported as **ambiguous** rather than guessed at, and a name-only match is reported as **unverified** and flagged in the workbook, the CSV, the notes, and the run warnings.

**Reading hours from the website.** Three layers, in confidence order: schema.org JSON-LD (`openingHoursSpecification` and the legacy `openingHours` shorthand), microdata, then visible page text. The highest-confidence layer that produced anything wins outright - layers are never merged, because combining a partial specification with text guesses would invent hours that appear in neither source. A day is only compared when the source actually says something about it, so a site listing Monday to Friday is reported as `partial`, never as closed at the weekend.

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
- `run.json` containing the complete machine-readable job, discovery evidence, results, warnings, and coverage notes

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

The test suite uses local fixture sites for 404, 410, server- and client-rendered soft 404, redirect, robots, nested/gzip sitemap, SearchApi, opening hours in JSON-LD, microdata and plain text, cancellation/resume, report reconciliation, and dashboard download workflows. External APIs, including Google Places, are exercised against local mock servers through their endpoint overrides. It does not scrape Google result pages or Google Maps directly.
