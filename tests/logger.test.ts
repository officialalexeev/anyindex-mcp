import assert from 'node:assert/strict';
import { suite, test } from 'node:test';

import { createLogger } from '../src/logger.js';

const capture = (level: string | undefined, run: () => void): string => {
  const previous = process.env.ANYINDEX_LOG_LEVEL;
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    if (level === undefined) delete process.env.ANYINDEX_LOG_LEVEL;
    else process.env.ANYINDEX_LOG_LEVEL = level;
    run();
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.ANYINDEX_LOG_LEVEL;
    else process.env.ANYINDEX_LOG_LEVEL = previous;
  }
  return chunks.join('');
};

suite('logger: ANYINDEX_LOG_LEVEL', () => {
  test('the level is case-insensitive', () => {
    const log = createLogger('test');

    const lower = capture('warn', () => {
      log.info('hidden');
      log.warn('shown');
    });
    const upper = capture('WARN', () => {
      log.info('hidden');
      log.warn('shown');
    });

    assert.ok(!lower.includes('hidden'), 'info must be below the threshold');
    assert.ok(lower.includes('shown'));
    assert.equal(upper, lower, 'WARN and warn are the same request');
  });

  test('an unknown level is named instead of silently becoming info', () => {
    const output = capture('verbose', () => {
      createLogger('test').info('marker');
    });

    assert.match(output, /unknown ANYINDEX_LOG_LEVEL "verbose"/);
    assert.match(output, /debug, info, warn, error/, 'the accepted values have to be listed');
    assert.ok(output.includes('marker'), 'the fallback level is still info');
  });

  test('an unset level prints info', () => {
    const output = capture(undefined, () => {
      const log = createLogger('test');
      log.debug('hidden');
      log.info('shown');
    });

    assert.ok(!output.includes('hidden'));
    assert.ok(output.includes('shown'));
  });
});