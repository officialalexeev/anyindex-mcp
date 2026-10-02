import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadConfig, readPackageVersion } from './config.js';
import { log } from './stats.js';
import {
  initTools,
  initWatcher,
  shutdownEmbedder,
  shutdownWatcher,
  startAutoIndexIfEnabled,
} from './tools.js';

export const SERVER_NAME = 'anyindex-mcp';
// Read from the manifest rather than repeating it: a hardcoded copy drifts on
// the first release that forgets to update it, and the client sees the drift.
export const SERVER_VERSION = readPackageVersion();

export function buildServer(): McpServer {
  const config = loadConfig();
  log.info('starting', {
    root: config.root,
    model: config.model,
    dtype: config.dtype,
    dimension: config.dimension,
    offline: config.offline,
    db: config.dbPath,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  initTools(server);

  server.registerTool(
    'ping',
    {
      description: 'Liveness probe. Returns the resolved configuration so client setup can be verified.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: { echo: z.string().optional() },
      outputSchema: {
        echo: z.string(),
        root: z.string(),
        model: z.string(),
        node: z.string(),
        index: z.string(),
        models: z.string(),
      },
    },
    async ({ echo }) => {
      const payload = {
        echo: echo ?? 'pong',
        root: config.root,
        model: config.model,
        node: process.version,
        index: config.dbPath,
        models: config.modelsDir,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  return server;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  log.info('connected', { transport: 'stdio' });

  // The embedding worker holds hundreds of megabytes. Without an explicit exit the
  // process outlives the broken connection: the client closes stdin, but Node does
  // not shut down while handles and threads are still alive.
  let exiting = false;
  const stop = () => {
    if (exiting) return;
    exiting = true;
    void shutdownWatcher()
      .then(() => shutdownEmbedder())
      .finally(() => process.exit(0));
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, stop);
  }
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);

  await initWatcher();
  startAutoIndexIfEnabled();
}