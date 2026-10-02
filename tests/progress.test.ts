import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, suite, test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

let root = '';

const connect = async (): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--root', root],
    env: { ...process.env, ANYINDEX_LOG_LEVEL: 'error' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'progress-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
};

suite('progress notifications', () => {
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'aidx-progress-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8');
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('index_status sends progress when the client asked for a token', async () => {
    const client = await connect();
    const seen: Array<{ phase: string; progress: number; total: number }> = [];

    try {
      client.setNotificationHandler(ProgressNotificationSchema, (n) => {
        seen.push({
          phase: String(n.params.message ?? ''),
          progress: Number(n.params.progress ?? 0),
          total: Number(n.params.total ?? 0),
        });
      });

      // The third argument is the options with onprogress; without it no token is
      // issued and no notifications arrive.
      await client.callTool({ name: 'index_status', arguments: {} }, undefined, { onprogress: () => {} });

      assert.ok(seen.length > 0, 'expected at least one notification');
      assert.ok(
        seen.some((n) => ['idle', 'scanning', 'chunking', 'embedding', 'done', 'failed'].includes(n.phase)),
        `the phase should be a known value, got ${JSON.stringify(seen)}`,
      );
    } finally {
      await client.close();
    }
  });

  test('without a requested token there are no notifications', async () => {
    const client = await connect();
    const seen: unknown[] = [];

    try {
      client.setNotificationHandler(ProgressNotificationSchema, (n) => {
        seen.push(n);
      });

      await client.callTool({ name: 'index_status', arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.equal(seen.length, 0, 'notifications must not be sent without a progressToken');
    } finally {
      await client.close();
    }
  });
});
