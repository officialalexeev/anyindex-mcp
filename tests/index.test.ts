import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, '--root', path.dirname(serverEntry)],
  });
  const client = new Client({ name: 'probe-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test('the server starts on stdio and announces its tools', async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      'anyindex_search', 'find_references', 'get_file_outline', 'index_rebuild', 'index_status', 'index_update', 'ping',
    ].sort());
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 0, `${tool.name}: a description is required`);
      assert.ok(typeof tool.annotations?.readOnlyHint === 'boolean', `${tool.name}: annotations are required`);
    }

    const search = tools.find((t) => t.name === 'anyindex_search');
    assert.equal(search?.annotations?.readOnlyHint, true);
    const rebuild = tools.find((t) => t.name === 'index_rebuild');
    assert.equal(rebuild?.annotations?.destructiveHint, true, 'an index rebuild must be marked destructive');
  } finally {
    await client.close();
  }
});

test('ping returns the resolved configuration', async () => {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'ping', arguments: { echo: 'привет' } });
    const payload = result.structuredContent as { echo: string; root: string; model: string; node: string };

    assert.equal(payload.echo, 'привет');
    assert.equal(payload.model, 'jinaai/jina-embeddings-v2-base-code');
    assert.ok(path.isAbsolute(payload.root));
    assert.equal(payload.node, process.version);
  } finally {
    await client.close();
  }
});

test('index_status honestly reports an unready index', async () => {
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'index_status', arguments: {} });
    const stats = result.structuredContent as { ready: boolean; degraded: boolean; reason?: string };
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';

    assert.equal(stats.ready, false, 'an empty index must not be reported as ready');
    assert.equal(stats.degraded, false, 'nothing has failed yet — the index was never built');
    assert.equal(typeof stats.reason, 'string', 'the reason must be named');
    assert.match(text, /NOT ready/);
    assert.match(text, /index_update|index_rebuild/, 'the text should suggest what to do');
  } finally {
    await client.close();
  }
});

test('stdout contains nothing but JSON-RPC', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'probe-client', version: '0.0.0' }, { capabilities: {} });

  let stdoutNoise = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  await client.connect(transport);

  await client.callTool({ name: 'ping', arguments: {} });
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdoutNoise += String(chunk);
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  await client.callTool({ name: 'index_status', arguments: {} });
  process.stdout.write = originalWrite;

  await client.close();
  assert.equal(stdoutNoise, '', `stdout should be empty, got: ${stdoutNoise}`);
});