import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, suite, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { buildBatches, Embedder } from '../src/embedder.js';

/**
 * A fake worker makes it possible to check closing without loading the 160 MB
 * model: the contract under test is just that the command reaches the thread and
 * the thread then terminates.
 */
interface FakeWorker {
  on: (event: string, handler: (payload: unknown) => void) => void;
  postMessage: (message: Record<string, unknown>) => void;
  terminate: () => Promise<number>;
}

function attachFakeWorker(
  embedder: Embedder,
  options: { respond?: boolean } = {},
): { sent: Array<Record<string, unknown>>; terminated: () => boolean } {
  const respond = options.respond ?? true;
  const sent: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  let terminated = false;

  const worker: FakeWorker = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    postMessage: (message) => {
      sent.push(message);
      if (respond) handlers.get('message')?.({ id: message.id, ok: true, payload: { closed: true } });
    },
    terminate: async () => {
      terminated = true;
      return 0;
    },
  };

  (embedder as unknown as { worker: unknown }).worker = worker;
  return { sent, terminated: () => terminated };
}

suite('embedder', () => {
  let root = '';

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-embedder-'));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('close sends shutdown before terminate', async () => {
    const embedder = new Embedder(loadConfig({ root }));
    const fake = attachFakeWorker(embedder);

    await embedder.close();

    assert.deepEqual(
      fake.sent.map((message) => message.type),
      ['shutdown'],
      `the wrong messages reached the worker: ${JSON.stringify(fake.sent)}`,
    );
    assert.equal(fake.terminated(), true, 'the thread should be terminated');
  });

  test('a second close does not throw and sends nothing', async () => {
    const embedder = new Embedder(loadConfig({ root }));
    const fake = attachFakeWorker(embedder);

    await embedder.close();
    await embedder.close();

    assert.equal(fake.sent.length, 1, 'after close the worker should not wake up again');
  });

  test('a request during close is rejected instead of going to a dying worker', async () => {
    const embedder = new Embedder(loadConfig({ root }));
    // The worker never answers: close() lives on a 500 ms timeout, and across
    // that whole window requests must be rejected rather than hang.
    attachFakeWorker(embedder, { respond: false });

    const closing = embedder.close();
    await assert.rejects(() => embedder.embed(['что-нибудь']), /is closing/);
    await closing;
  });

  suite('buildBatches', () => {
    test('a batch is limited by characters, not by item count', () => {
      const texts = Array.from({ length: 6 }, () => 'x'.repeat(100));

      const batches = buildBatches(texts, 250, 16);

      assert.ok(batches.length > 1, 'six hundred characters must not fit into one batch');
      for (const batch of batches) {
        assert.ok(batch.length <= 2, `${batch.length} items in a batch with a 250 character limit`);
      }
    });

    test('the item count limit applies too', () => {
      const texts = Array.from({ length: 5 }, () => 'a');

      const batches = buildBatches(texts, 10_000, 2);

      assert.deepEqual(batches.map((b) => b.length), [2, 2, 1]);
    });

    test('nothing is lost and the order is preserved', () => {
      const texts = ['a', 'bb', 'ccc', 'dddd'];

      const batches = buildBatches(texts, 4, 3);

      assert.deepEqual(batches.flat(), texts);
    });
  });
});