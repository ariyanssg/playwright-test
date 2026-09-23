import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import { ScanService } from '../../src/service.js';
import { startDashboard } from '../../src/server.js';
import { ProfileBrowser } from '../../src/profile/website.js';
import { auditProfile } from '../../src/profile/audit.js';
import { makeWeeklyHours, DAY_INDEXES } from '../../src/hours/schedule.js';
import type { ImportedProfile } from '../../src/profile/model.js';

async function fixture() {
  const methods: string[] = [];
  const server = createServer((req,res)=>{
    methods.push(`${req.method} ${req.url}`);
    const root=`http://${req.headers.host}`;
    if(req.url==='/robots.txt') return void res.writeHead(200,{'content-type':'text/plain'}).end('User-agent: *\nDisallow: /private');
    if(req.url==='/private') return void res.end('Private');
    if(req.url==='/old-menu') return void res.writeHead(301,{location:'/menu'}).end();
    if(req.url==='/broken') return void res.writeHead(404,{'content-type':'text/html'}).end('<h1>Page not found</h1>');
    if(req.url==='/blocked') return void res.writeHead(403).end('Access denied');
    if(req.url==='/soft') return void res.writeHead(200,{'content-type':'text/html'}).end('<h1>Page not found</h1>');
    const schema={'@context':'https://schema.org','@type':'Restaurant',name:'Rimjhim Southampton',telephone:'023 8019 0100',url:root+'/',address:{streetAddress:'69 The Avenue',addressLocality:'Southampton',postalCode:'SO17 1XS'},openingHoursSpecification:[{dayOfWeek:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],opens:'12:00',closes:'22:00'}],specialOpeningHoursSpecification:[{validFrom:'2026-12-25',validThrough:'2026-12-25',opens:'00:00',closes:'00:00'}]};
    const body=req.url==='/menu'?'<h1>Menu</h1><p>Starters £5, Main courses £15, Desserts £6</p>':req.url==='/book'?'<h1>Reserve a table</h1><form action="/submit" method="post"><input type="date" name="date"><select name="guests"><option>2 guests</option></select><button>Book table</button></form>':req.url==='/order'?'<h1>Online ordering</h1><p>Add to basket</p><button>Checkout</button>':'<h1>Rimjhim Southampton</h1><p>Welcome to our restaurant.</p>';
    res.writeHead(200,{'content-type':'text/html'}).end(`<!doctype html><title>Rimjhim Southampton</title>${req.url==='/'?`<script type="application/ld+json">${JSON.stringify(schema)}</script>`:''}<main>${body}</main><nav><a href="/menu">Menu</a><a href="/book">Reservations</a><a href="/order">Order online</a></nav><address>69 The Avenue, Southampton SO17 1XS</address><a href="tel:02380190100">023 8019 0100</a>`);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as {port:number}).port, root=`http://127.0.0.1:${port}`;
  const evidence:ImportedProfile={url:root+'/',observedAt:'2026-09-09T10:00:00Z',name:'Rimjhim Southampton',address:'69 The Avenue, Southampton SO17 1XS',phone:'023 8019 0100',website:root+'/',timezone:'Europe/London',weekly:makeWeeklyHours(DAY_INDEXES.map(d=>({start:d*1440+720,end:d*1440+1320})),DAY_INDEXES),exceptions:{'2026-12-25':[]},services:{menu:[root+'/old-menu'],reservations:[root+'/book'],ordering:[root+'/order',root+'/broken']}};
  return {root,evidence,methods,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
const browser=()=>new ProfileBrowser({pageLimit:10,timeoutMs:5000,hostDelayMs:0},true);

test('rendered website, imported profile, link health, durable exports and dashboard agree', {timeout:90000}, async()=>{
  const site=await fixture(), directory=await mkdtemp(join(tmpdir(),'profile-e2e-'));
  const service=new ScanService(join(directory,'audit.sqlite'),undefined,{browser:browser()});
  const dashboard=await startDashboard(service,0), ui=await chromium.launch();
  try {
    const page=await ui.newPage({viewport:{width:1280,height:900}});
    await page.goto(dashboard.url+'/#new-audit');
    await page.locator('#sites').fill(site.root+'/');
    // Enabling the profile comparison keeps the chosen URL sources; this test stays offline.
    assert.equal(await page.locator('[name="discovery"][value="google"]').isChecked(),true);
    await page.locator('#check-profile').check();
    assert.equal(await page.locator('[name="discovery"][value="google"]').isChecked(),true);
    await page.locator('[data-preset="import"]').click();
    await page.locator('#profile-mode').selectOption('imported');
    await page.locator('#profile-evidence').fill(JSON.stringify([site.evidence]));
    await page.locator('#profile-address').fill(site.evidence.address!);
    await page.locator('#start-button').click();
    await page.waitForFunction(()=>document.querySelector('#profile-results')?.textContent?.includes('Website publishes') || document.querySelector('#profile-results')?.textContent?.includes('Service link checks'),null,{timeout:60000});
    const scan=service.listScans()[0]!;
    await service.start(scan.id);
    const report=service.profiles(scan.id)[0]!;
    assert.equal(report.identity.status,'verified');
    assert.equal(report.checks.find(c=>c.field==='name')?.verdict,'match');
    assert.equal(report.checks.find(c=>c.field==='hours.Monday')?.verdict,'match');
    assert.equal(report.checks.find(c=>c.field==='special_hours.2026-12-25')?.verdict,'match');
    assert.equal(report.links.find(l=>l.url.endsWith('/old-menu'))?.health,'functional');
    assert.equal(report.links.find(l=>l.url.endsWith('/broken'))?.health,'hard_404');
    assert.equal(report.links.find(l=>l.url.endsWith('/book'))?.health,'functional');
    assert.ok(site.methods.every(m=>m.startsWith('GET ')),'No reservation or order was submitted');
    const json=JSON.parse(await readFile(join(scan.outputDir,'profile-audit.json'),'utf8'));
    assert.equal(json.reports[0].retention,'durable');
    assert.ok(json.reports[0].checks.some((c:any)=>c.field==='name' && c.google.includes('Rimjhim Southampton')));
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(join(scan.outputDir,'report.xlsx'));
    assert.ok(workbook.getWorksheet('Field Comparisons'));
    assert.ok(workbook.getWorksheet('Service Links'));
    const api=await fetch(`${dashboard.url}/api/scans/${scan.id}/profiles`).then(r=>r.json());
    assert.equal(api.reports[0].summary.brokenLinks,report.summary.brokenLinks);
    await page.reload();await page.locator('#profile-results:not(.hidden)').waitFor();
    await page.locator('#profile-results summary').filter({hasText:'Service link checks'}).click();
    assert.match(await page.locator('#profile-results').innerText(),/hard_404/);
    await mkdir(resolve('output/playwright'),{recursive:true});
    await page.screenshot({path:resolve('output/playwright/profile-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await page.screenshot({path:resolve('output/playwright/profile-mobile.png'),fullPage:true});
  } finally {await ui.close();await dashboard.close();service.close();await site.close();}
});

test('public API partial coverage is explicit and Google values never reach disk', {timeout:45000},async()=>{
  const site=await fixture(), directory=await mkdtemp(join(tmpdir(),'profile-public-'));
  const service=new ScanService(join(directory,'audit.sqlite'),undefined,{browser:browser(),publicRead:async()=>({id:'fixture-place',displayName:{text:'SECRET GOOGLE NAME'},formattedAddress:site.evidence.address,websiteUri:site.root+'/',internationalPhoneNumber:'+44 23 8019 0100'})});
  try {
    const scan=service.createScan({profileTargets:[{url:site.root+'/',placeId:'fixture-place'}],checkProfile:true,profileMode:'public',outputDir:directory,hostDelayMs:0,timeoutMs:5000});
    await service.start(scan.id);
    const live=service.profiles(scan.id)[0]!;
    assert.equal(live.identity.status,'verified');
    assert.equal(live.checks.find(c=>c.field==='name')?.verdict,'mismatch');
    assert.equal(live.checks.find(c=>c.field==='services.menu')?.verdict,'unverifiable');
    assert.equal(service.getScan(scan.id)?.status,'completed_partial');
    const stored=service.db.listProfiles(scan.id)[0]!;
    assert.equal(stored.retention,'redacted');assert.equal(JSON.stringify(stored).includes('SECRET GOOGLE NAME'),false);
    assert.equal((await readFile(join(scan.outputDir,'run.json'),'utf8')).includes('SECRET GOOGLE NAME'),false);
    assert.equal((await readFile(join(scan.outputDir,'profile-report.html'),'utf8')).includes('SECRET GOOGLE NAME'),false);
  } finally {service.close();await site.close();}
});

test('network guard prevents even robots requests to local services', {timeout:20000},async()=>{
  const site=await fixture();
  const guarded=new ProfileBrowser({pageLimit:2,timeoutMs:3000,hostDelayMs:0});
  try {
    const snapshot=await guarded.crawl({url:site.root+'/'});
    assert.equal(snapshot.pages.length,0);
    assert.equal(site.methods.length,0);
    assert.equal(snapshot.coverage.name?.state,'partial');
  } finally {await guarded.close();await site.close();}
});

test('cancelled profile still contains every required comparison', {timeout:10000},async()=>{
  const signal=AbortSignal.abort();
  const report=await auditProfile('cancel',{url:'https://example.com'}, {mode:'public',pageLimit:1,timeoutMs:1000,hostDelayMs:0,country:'GB',tolerance:0,signal});
  assert.equal(report.status,'cancelled');
  for(const field of ['name','phone','website','services.menu','services.reservations','services.ordering']) assert.ok(report.checks.some(c=>c.field===field));
});
