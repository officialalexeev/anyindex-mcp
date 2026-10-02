import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { suite, test } from 'node:test';

import { jobState, requestRerun, resetJob, startJob } from '../src/job.js';

/**
 * Waits for the wanted number of passes and for the job to go idle again.
 *
 * Waiting on the pass counter alone is not enough: the body of a pass increments
 * it before the job is marked done. Until the promise chain has drained, the
 * next startJob returns started: false and the tests start interfering with
 * each other.
 */
async function settle(get: () => number, wanted: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((get() < wanted || jobState().running) && Date.now() < deadline) await delay(10);
  await delay(30);
}

suite('background job', () => {
  test('a pass requested while one is running runs next', async () => {
    resetJob();
    let runs = 0;

    startJob(async () => {
      runs += 1;
      // Request a rerun only on the first pass: a body that requested one
      // unconditionally would loop itself forever - in the real code
      // requestRerun is called by watcher events, which do not repeat
      // without further edits.
      if (runs === 1) requestRerun();
      await delay(20);
    });

    await settle(() => runs, 2);

    assert.equal(runs, 2, `expected two passes - the current one and the deferred one, got ${runs}`);
    assert.equal(jobState().running, false, 'after the deferred pass the job must not still be running');
  });

  test('without a request there is no extra pass', async () => {
    resetJob();
    let runs = 0;

    startJob(async () => {
      runs += 1;
      await delay(20);
    });
    await settle(() => runs, 1);
    await delay(200);

    assert.equal(runs, 1, `expected one pass, got ${runs}`);
  });

  test('a request outside a running job starts nothing', async () => {
    resetJob();

    requestRerun();

    assert.equal(jobState().running, false, 'requestRerun should not start a pass by itself');
  });

  test('repeated requests do not pile up passes', async () => {
    resetJob();
    let runs = 0;

    startJob(async () => {
      runs += 1;
      if (runs === 1) {
        requestRerun();
        requestRerun();
        requestRerun();
      }
      await delay(20);
    });

    await settle(() => runs, 2);
    await delay(200);

    assert.equal(runs, 2, `three requests should give one deferred pass, got ${runs}`);
  });
});