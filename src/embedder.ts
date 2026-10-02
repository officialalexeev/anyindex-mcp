import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createLogger } from './logger.js';
import type { ServerConfig } from './config.js';

const log = createLogger('embedder-client');

type Response = { id: number; ok: true; payload: unknown } | { id: number; ok: false; error: string };

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 500;

/**
 * ONNX inference takes seconds and blocks the event loop. For an MCP server on
 * stdio that means the client stops getting replies for the duration of the
 * embedding, so the model runs in a separate thread.
 */
export class Embedder {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closing = false;

  constructor(private readonly config: ServerConfig) {}

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker;

    const here = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(here, 'embedder.worker.js');

    const worker = new Worker(workerPath, {
      workerData: {
        model: this.config.model,
        dtype: this.config.dtype,
        cacheDir: this.config.modelsDir,
        offline: this.config.offline,
        idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      },
      // The heap limit is deliberately left unset. The model takes ~160 MB and
      // raising the limit looks reasonable, but on a machine with 2 GB of RAM it
      // gets the process OOM-killed: Node reserves more heap than there is
      // physical memory and the kernel kills the process. Node's default is
      // derived from the available memory and stays correct on any machine.
    });

    worker.on('message', (message: Response) => {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);

      if (message.ok) entry.resolve(message.payload);
      else entry.reject(new Error(message.error));
    });

    worker.on('error', (error) => {
      this.rejectAll(error);
      this.worker = null;
    });

    worker.on('exit', (code) => {
      this.rejectAll(new Error(`embedder worker exited with code ${code}`));
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private send<T>(request: Record<string, unknown>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('embedder is closing'));

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (p: unknown) => void, reject });
      this.ensureWorker().postMessage({ id, ...request });
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const { vectors } = await this.send<{ vectors: Float32Array[] }>({ type: 'embed', texts });
    return vectors;
  }

  /**
   * Batches are limited by total character count, not by item count.
   *
   * Texts are sorted by length before splitting: transformers.js pads every
   * item in a batch to the longest one, and self-attention is quadratic in
   * length. So a batch with one long chunk also slows down the short ones.
   * Single-core measurement: 16 short chunks — 350 ms/chunk, 16 mixed —
   * 4200 ms/chunk.
   */
  async embedBatched(
    texts: string[],
    maxCharsPerBatch = 8_000,
    maxItemsPerBatch = 16,
  ): Promise<Float32Array[]> {
    const order = texts.map((text, index) => ({ text, index })).sort((a, b) => a.text.length - b.text.length);
    const batches = buildBatches(order.map((item) => item.text), maxCharsPerBatch, maxItemsPerBatch);

    const sorted: Float32Array[] = [];
    for (const batch of batches) {
      sorted.push(...(await this.embed(batch)));
    }

    // Restoring the original order is mandatory: the caller matches a vector to
    // its chunk by position.
    const restored = new Array<Float32Array>(texts.length);
    let cursor = 0;
    for (const item of order) {
      const vector = sorted[cursor];
      cursor += 1;
      if (vector !== undefined) restored[item.index] = vector;
    }
    return restored;
  }

  /**
   * Closing must not depend on the worker's reply: when it is busy running
   * inference on a single core the reply arrives minutes later, and the
   * process holding the model in memory stays alive after the client drops the
   * connection.
   */
  async close(): Promise<void> {
    const worker = this.worker;
    if (worker === null) return;

    // The request goes out before closing is set: send rejects everything that
    // arrives after it, and "graceful" shutdown silently turned into
    // terminate().
    const graceful = this.send({ type: 'shutdown' });
    this.closing = true;
    try {
      await Promise.race([
        graceful,
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
    } catch {
      // The worker may already be gone — not a reason to fail the close
    }

    this.worker = null;
    this.closing = false;
    this.rejectAll(new Error('embedder closed'));

    await worker.terminate();
  }
}

export function buildBatches(texts: string[], maxChars: number, maxItems: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;

  for (const text of texts) {
    const size = text.length;
    if (current.length > 0 && (currentChars + size > maxChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}