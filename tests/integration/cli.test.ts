import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { startFixtureSite } from '../helpers/fixture-site.js';

test('CLI enforces configuration errors and fail-on exit codes while keeping secrets out of output', async () => {
  const fixture = await startFixtureSite();
  const directory = await mkdtemp(join(tmpdir(), 'seo404-cli-'));
  const environment = {
    ...process.env,
    SEO404_DATA_DIR: join(directory, 'data'),
    // The CLI loads the project .env at startup, and loadEnvFile never overwrites a variable
    // that is already set. Pinning the client id to empty keeps the missing-credential
    // assertion below true whatever real credentials the developer has configured locally.
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: 'must-not-leak-google-secret',
    SEARCHAPI_API_KEY: 'must-not-leak-searchapi-secret',
    DATAFORSEO_LOGIN: 'must-not-leak-backlink-login',
    DATAFORSEO_PASSWORD: 'must-not-leak-backlink-secret',
  };
  try {
    const help = await runCli(['help'], environment);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Restaurant SEO 404 Auditor/);
    assert.match(help.stdout, /backlinks/);
    const unknown = await runCli(['not-a-command'], environment);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /Unknown command/);
    const authWithoutClient = await runCli(['auth', 'google'], environment);
    assert.equal(authWithoutClient.code, 1);
    assert.match(authWithoutClient.stderr, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required/);

    const invalid = await runCli(['scan', '--url', `${fixture.origin}/ok`, '--discover', 'unknown'], environment);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /Unknown discovery source/);

    const hard = await runCli([
      'scan', '--url', `${fixture.origin}/hard`, '--url', `${fixture.origin}/soft`, '--discover', 'import',
      '--output', join(directory, 'hard-runs'), '--host-delay', '0', '--fail-on', 'hard',
    ], environment);
    assert.equal(hard.code, 2);
    assert.match(hard.stdout, /Status: completed/);
    assert.match(hard.stdout, /findings/);
    const hardScanId = hard.stdout.match(/^Scan (.+)$/m)?.[1];
    assert.ok(hardScanId);
    const resumedHard = await runCli(['resume', hardScanId], environment);
    assert.equal(resumedHard.code, 2, 'resume preserves the scan failure threshold contract');

    const softAllowed = await runCli([
      'scan', '--url', `${fixture.origin}/soft`, '--discover', 'import', '--output', join(directory, 'soft-allowed-runs'),
      '--host-delay', '0', '--fail-on', 'hard',
    ], environment);
    assert.equal(softAllowed.code, 0);

    const softFailed = await runCli([
      'scan', '--url', `${fixture.origin}/soft`, '--discover', 'import', '--output', join(directory, 'soft-failed-runs'),
      '--host-delay', '0', '--fail-on', 'soft',
    ], environment);
    assert.equal(softFailed.code, 2);
    const reportMatch = softFailed.stdout.match(/^Report: (.+)\/report\.xlsx$/m);
    const reportDir = reportMatch?.[1];
    assert.ok(reportDir);
    const runJson = await readFile(join(reportDir, 'run.json'), 'utf8');
    const combinedOutput = `${hard.stdout}${hard.stderr}${softAllowed.stdout}${softAllowed.stderr}${softFailed.stdout}${softFailed.stderr}${runJson}`;
    assert.doesNotMatch(combinedOutput, /must-not-leak-google-secret|must-not-leak-searchapi-secret|must-not-leak-backlink-login|must-not-leak-backlink-secret/);

    const listed = await runCli(['list'], environment);
    assert.equal(listed.code, 0);
    assert.match(listed.stdout, /completed/);

    const badConcurrency = await runCli(['scan', '--url', `${fixture.origin}/ok`, '--concurrency', '0'], environment);
    assert.equal(badConcurrency.code, 1);
    assert.match(badConcurrency.stderr, /concurrency must be a positive integer/);

    const served = await runServeUntilReady(environment);
    assert.equal(served.code, 0);
    assert.match(served.stdout, /Dashboard: http:\/\/127\.0\.0\.1:/);
  } finally {
    await fixture.close();
  }
});

interface CliResult { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: projectRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function runServeUntilReady(environment: NodeJS.ProcessEnv): Promise<CliResult> {
  const projectRoot = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'serve', '--port', '0'], {
      cwd: projectRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stopping = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('CLI serve did not become ready'));
    }, 10_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (!stopping && stdout.includes('Dashboard:')) {
        stopping = true;
        setTimeout(() => child.kill('SIGTERM'), 100);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}
