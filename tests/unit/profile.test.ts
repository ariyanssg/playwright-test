import assert from 'node:assert/strict';
import test from 'node:test';
import { compareProfiles, durableReport, resolveIdentity, summarize } from '../../src/profile/audit.js';
import { emptySnapshot, fact, first, validateImports, type ProfileSnapshot, type ProfileReport } from '../../src/profile/model.js';
import { fromImported, fromPlace, managedProfiles, paginate, BusinessProfileConnection } from '../../src/profile/providers.js';
import { dayIntervals, phone, urlKey } from '../../src/profile/normalize.js';
import { makeWeeklyHours } from '../../src/hours/schedule.js';
import { mergeScanOptions } from '../../src/config.js';

function website(): ProfileSnapshot {
  const s = emptySnapshot('website');
  for (const [field, value] of Object.entries({ name: 'Rimjhim Southampton', address: '69 The Avenue, Southampton SO17 1XS', phone: '023 8019 0100', website: 'https://restaurant.test/' })) fact(s, field, value, 'https://restaurant.test/', 'fixture');
  return s;
}
function google(): ProfileSnapshot { return fromImported({ url: 'https://restaurant.test/', observedAt: '2026-09-09T10:00:00Z', name: 'Rimjhim Southampton', address: '69 The Avenue, Southampton SO17 1XS, United Kingdom', phone: '+44 23 8019 0100', website: 'https://restaurant.test/', services: { menu: [], reservations: [], ordering: [] } }); }

test('profile options are opt-in, strict by default and validate imported URLs', () => {
  assert.equal(mergeScanOptions({}).checkProfile, false);
  assert.deepEqual(mergeScanOptions({ sites: ['https://example.com'], checkProfile: true }).discovery, ['import']);
  assert.equal(mergeScanOptions({checkProfile: true}).profileHoursTolerance, 0);
  assert.throws(() => validateImports([{url:'file:///etc/passwd',observedAt:'2026-09-09'}]));
  assert.throws(() => validateImports([{url:'https://test.com',observedAt:'bad'}]));
  assert.throws(() => validateImports([{url:'https://test.com',observedAt:'2026-09-09',services:{menu:['javascript:alert(1)']}}]));
  assert.throws(() => validateImports([{url:'https://test.com',observedAt:'2026-09-09',weekly:{statedDays:[1],open24x7:false,intervals:[{start:100,end:50}]}}]));
});
test('phone equality includes extensions and meaningful URL parts survive', () => {
  assert.equal(phone('023 8019 0100'), phone('+44 23 8019 0100'));
  assert.notEqual(phone('023 8019 0100 ext. 2'), phone('023 8019 0100 ext. 3'));
  assert.equal(phone('123'), null);
  assert.notEqual(urlKey('https://test.com/order?branch=1'), urlKey('https://test.com/order?branch=2'));
  assert.notEqual(urlKey('https://test.com/#menu'), urlKey('https://test.com/#booking'));
});
test('branch resolution does not hide incorrect GBP website or name', () => {
  const w = website(), g = google();
  g.facts.find(f => f.field === 'website')!.value = 'https://wrong.test';
  g.facts.find(f => f.field === 'name')!.value = 'Incorrect Name';
  assert.equal(resolveIdentity({url:'https://restaurant.test/'}, w, [g], 'GB').identity.status, 'verified');
  const other = google(); other.facts.find(f => f.field === 'address')!.value = '11 Other Street, London'; other.facts.find(f => f.field === 'phone')!.value = '+44 20 7946 0999';
  assert.equal(resolveIdentity({url:'https://restaurant.test/',placeId:'wrong'}, w, [other], 'GB').identity.status, 'unverified');
  assert.equal(resolveIdentity({url:'https://restaurant.test/'}, w, [g, google()], 'GB').identity.status, 'ambiguous');
});
test('name remains exact and phone formatting has a separate equivalent result', () => {
  const w = website(), g = google();
  g.facts.find(f => f.field === 'name')!.value = 'RIMJHIM SOUTHAMPTON';
  const checks = compareProfiles(w,g,true,'GB',0,[]);
  assert.equal(checks.find(c => c.field === 'name')?.verdict,'equivalent');
  assert.equal(checks.find(c => c.field === 'name')?.exactMatch,false);
  assert.equal(checks.find(c => c.field === 'phone')?.semanticMatch,true);
  assert.equal(checks.find(c => c.field === 'phone')?.exactMatch,false);
});
test('unavailable public action links are never called missing', () => {
  const w = website(), g = fromPlace({id:'id',displayName:{text:'Rimjhim Southampton'}});
  w.links.push({service:'menu',url:'https://restaurant.test/menu',label:'Menu',source:'website'});
  w.coverage['services.menu'] = {state:'present',reason:'navigation'};
  const check = compareProfiles(w,g,true,'GB',0,[]).find(c => c.field === 'services.menu');
  assert.equal(check?.verdict,'unverifiable');
  assert.match(check!.reason,/does not expose/);
});
test('within tolerance still reports an hours mismatch and unknown is not closed', () => {
  const w = website(), g = google();
  fact(w,'hours',makeWeeklyHours([{start:1440+660,end:1440+1320}],[1]),'', 'fixture');
  fact(g,'hours',makeWeeklyHours([{start:1440+660,end:1440+1330}],[1]),'', 'fixture');
  const checks = compareProfiles(w,g,true,'GB',15,[]);
  assert.equal(checks.find(c => c.field === 'hours.Monday')?.verdict,'mismatch');
  assert.equal(checks.find(c => c.field === 'hours.Monday')?.severity,'warning');
  assert.equal(checks.find(c => c.field === 'hours.Sunday')?.verdict,'unverifiable');
});
test('overnight coverage rolls across the week boundary and merges midnight splits', () => {
  const a = makeWeeklyHours([{start:6*1440+1380,end:10080+120}],[0,6]);
  const b = makeWeeklyHours([{start:6*1440+1380,end:10080},{start:0,end:120}],[0,6]);
  assert.deepEqual(dayIntervals(a,0),[{start:0,end:120}]);
  assert.deepEqual(dayIntervals(a,6),dayIntervals(b,6));
  assert.deepEqual(dayIntervals(a,0),dayIntervals(b,0));
  assert.equal(dayIntervals(a,1),null);
});
test('conflicting website schedules remain visible', () => {
  const w=website(),g=google();
  for (const end of [1200,1320]) fact(w,'hours',makeWeeklyHours([{start:1440+660,end:1440+end}],[1]),'',`source ${end}`);
  fact(g,'hours',first(w,'hours'),'', 'provider');
  assert.equal(compareProfiles(w,g,true,'GB',0,[]).find(c=>c.field==='hours.Monday')?.verdict,'source_conflict');
});
test('dated exceptions compare only when timezone and both dates exist', () => {
  const w=website(),g=google();
  fact(w,'special_hours',{'2026-12-25':[]},'', 'fixture'); fact(g,'special_hours',{'2026-12-25':[]},'', 'fixture');
  assert.equal(compareProfiles(w,g,true,'GB',0,[]).find(c=>c.field==='special_hours.2026-12-25')?.verdict,'unverifiable');
  fact(g,'timezone','Europe/London','', 'fixture');
  assert.equal(compareProfiles(w,g,true,'GB',0,[]).find(c=>c.field==='special_hours.2026-12-25')?.verdict,'match');
});
test('managed provider paginates all actions and maps menu separately', async () => {
  const calls:string[]=[];
  const sources=await managedProfiles('locations/42',async url=>{
    calls.push(url);
    if (url.includes('getGoogleUpdated')) return {location:{name:'locations/42',title:'Updated'}};
    if (url.endsWith('/attributes')) return {attributes:[{name:'attributes/url_menu',uriValues:[{uri:'https://restaurant.test/menu'}]}]};
    if (url.includes('placeActionLinks')) return url.includes('pageToken=next') ? {placeActionLinks:[{uri:'https://restaurant.test/order',placeActionType:'FOOD_TAKEOUT',providerType:'MERCHANT'}]} : {placeActionLinks:[{uri:'https://restaurant.test/book',placeActionType:'DINING_RESERVATION',isPreferred:true}],nextPageToken:'next'};
    return {name:'locations/42',title:'Rimjhim',regularHours:{periods:[]}};
  });
  assert.equal(sources[0]!.links.length,3);
  assert.equal(sources[1]!.source,'gbp_google_updated');
  assert.equal(sources[0]!.coverage['services.ordering']!.state,'present');
  assert.ok(calls.some(u=>u.includes('pageToken=next')));
  await assert.rejects(()=>paginate('https://test.com/list','items',async()=>({items:[],nextPageToken:'repeat'})),/repeated/);
});
test('Google persistence redacts raw observations, derived comparisons and warnings', () => {
  const w=website(),g=google();g.source='places';
  const checks=compareProfiles(w,g,true,'GB',0,[]);
  const report:ProfileReport={schemaVersion:'1.0',auditId:'a',targetKey:'k',target:{url:'https://restaurant.test/'},mode:'public',startedAt:'now',completedAt:'now',status:'completed_partial',identity:{status:'verified',placeId:'id',reason:'SECRET'},checks,links:[],sources:[w,g],pages:[],summary:summarize(checks,[],true),warnings:['SECRET'],retention:'session_only',rules:{version:'1.0',country:'GB',hoursToleranceMinutes:0}};
  const saved=durableReport(report);
  assert.equal(saved.retention,'redacted');
  assert.ok(saved.checks.every(c=>c.verdict==='unverifiable' && c.google.length===0));
  assert.ok(saved.sources.every(s=>s.source==='website'));
  assert.equal(JSON.stringify(saved).includes('SECRET'),false);
  assert.equal(report.identity.status,'verified');
});
test('GBP uses an independent token file',()=>{
  const connection=new BusinessProfileConnection();
  assert.match(connection.tokenPath,/gbp-token\.json$/);
});
