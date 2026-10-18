import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endedHeadline, formatFilmTime, jobCanRetry, jobHasFailed, jobIsActive, latestExportAttempts, retryExport, type ExportJob, type ExportJobStatus } from './export-jobs.ts';

test('the dialog\'s times: tenths only where the time is not a whole second', () => {
  assert.equal(formatFilmTime(7500), '0:07.5');
  assert.equal(formatFilmTime(11_500), '0:11.5');
  assert.equal(formatFilmTime(12_000), '0:12');
  assert.equal(formatFilmTime(4000), '0:04');
  assert.equal(formatFilmTime(3333), '0:03.3');
  assert.equal(formatFilmTime(59_960), '1:00');
  assert.equal(formatFilmTime(3_725_400), '1:02:05.4');
});

const job = (status: ExportJobStatus) => ({ status }) as ExportJob;
const words = (key: string) => key.replace('exportTray.', '');
const headline = (...statuses: ExportJobStatus[]) => endedHeadline(statuses.map(job), words);

test('the tray says how the exports ended: cancelled is not finished, and a mix says each part', () => {
  assert.deepEqual(headline('done', 'done'), { tone: 'ok', text: 'finished' });
  assert.deepEqual(headline('cancelled'), { tone: 'muted', text: 'cancelledOne' });
  assert.deepEqual(headline('cancelled', 'cancelled'), { tone: 'muted', text: 'cancelledAll' });
  assert.deepEqual(headline('failed'), { tone: 'err', text: 'failedOne' });
  assert.deepEqual(headline('failed', 'failed'), { tone: 'err', text: 'failedAll' });
  assert.deepEqual(headline('interrupted'), { tone: 'err', text: 'failedOne' });
  assert.deepEqual(headline('interrupted', 'failed'), { tone: 'err', text: 'failedAll' });
  assert.deepEqual(headline('done', 'cancelled', 'cancelled'), { tone: 'ok', text: 'countDone, countCancelled' });
  assert.deepEqual(headline('cancelled', 'failed'), { tone: 'err', text: 'countCancelled, countFailed' });
  assert.deepEqual(headline('done', 'cancelled', 'failed'), { tone: 'err', text: 'countDone, countCancelled, countFailed' });
});

test('interrupted exports stay stopped and are shown as failures', () => {
  assert.equal(jobIsActive(job('interrupted')), false);
  assert.equal(jobHasFailed(job('interrupted')), true);
  assert.equal(jobHasFailed(job('done')), false);
  assert.equal(jobCanRetry(job('cancelled')), true);
  assert.equal(jobCanRetry(job('waiting')), false);
});

test('a recovered attempt replaces its old failure in the tray without deleting its receipt', () => {
  const original = { ...job('interrupted'), id: 'old' };
  const retry = { ...job('failed'), id: 'retry', retryOf: 'old' };
  const final = { ...job('done'), id: 'final', retryOf: 'retry' };
  const ledger = [final, retry, original];
  assert.deepEqual(latestExportAttempts(ledger), [final]);
  assert.equal(ledger.length, 3);
});

test('retry posts to the exact job then refreshes the durable export records', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const records = [{ id: 'new-attempt', status: 'waiting' }, { id: 'old-attempt', status: 'interrupted' }];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(init?.method === 'POST' ? { export: records[0] } : { exports: records }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await retryExport('project one', 'old/attempt'), records);
  assert.deepEqual(calls.map((call) => [call.url, call.init?.method ?? 'GET']), [
    ['/api/projects/project%20one/exports/old%2Fattempt/retry', 'POST'], ['/api/projects/project%20one/exports', 'GET'],
  ]);
});

test('a rejected retry does not fabricate a local attempt or read a guessed result', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(JSON.stringify({ error: 'only a stopped export can be retried' }), { status: 409 }); });
  await assert.rejects(retryExport('project', 'active-job'), /only a stopped export/);
  assert.equal(calls, 1);
});

test('a committed retry receipt survives a failed record refresh', async (t) => {
  const queued = { id: 'new-attempt', status: 'waiting' };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls > 1) throw new Error('connection went away');
    return new Response(JSON.stringify({ export: queued }), { status: 200 });
  });
  assert.deepEqual(await retryExport('project', 'old-attempt'), [queued]);
  assert.equal(calls, 2);
});
