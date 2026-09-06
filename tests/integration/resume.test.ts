import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScanService } from '../../src/service.js';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('cancellation writes a partial report and resume finishes pending URLs', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-resume-'));
  const service = new ScanService(join(directory, 'scan.sqlite'));
  try {
    const scan = service.createScan({
      urls: Array.from({ length: 4 }, (_, index) => `${fixture.origin}/slow?case=${index}`),
      discovery: ['import'],
      outputDir: join(directory, 'runs'),
      concurrency: 1,
      perHostConcurrency: 1,
      hostDelayMs: 0,
      timeoutMs: 3_000,
      failOn: 'none',
    });
    let cancelled = false;
    const unsubscribe = service.onProgress(scan.id, (event) => {
      if (!cancelled && event.status === 'scanning' && event.processed >= 1) {
        cancelled = true;
        service.cancel(scan.id);
      }
    });
    const partial = await service.start(scan.id);
    unsubscribe();
    assert.equal(partial.status, 'cancelled');
    assert.ok(partial.processed >= 1 && partial.processed < 4);
    const partialJson = JSON.parse(await readFile(join(partial.outputDir, 'run.json'), 'utf8'));
    assert.equal(partialJson.scan.status, 'cancelled');

    const completed = await service.resume(scan.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.processed, 4);
    const finalJson = JSON.parse(await readFile(join(completed.outputDir, 'run.json'), 'utf8'));
    assert.equal(finalJson.scan.status, 'completed');
    assert.equal(finalJson.candidates.filter((candidate: { status: string }) => candidate.status === 'complete').length, 4);
  } finally {
    service.close();
    await fixture.close();
  }
});
