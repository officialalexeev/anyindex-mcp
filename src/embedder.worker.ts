import { parentPort, workerData } from 'node:worker_threads';

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

interface WorkerConfig {
  model: string;
  dtype: string;
  cacheDir: string;
  offline: boolean;
  idleTimeoutMs: number;
}

type Extractor = FeatureExtractionPipeline | null;

const config = workerData as WorkerConfig;

env.cacheDir = config.cacheDir;
env.allowRemoteModels = !config.offline;
env.allowLocalModels = true;

let extractorPromise: Promise<Extractor> | null = null;
let lastUsedAt = Date.now();

function log(message: string, detail?: unknown): void {
  const line = `[embedder] ${message}`;
  process.stderr.write(detail === undefined ? `${line}\n` : `${line} ${JSON.stringify(detail)}\n`);
}

function loadExtractor(): Promise<Extractor> {
  if (extractorPromise === null) {
    const started = Date.now();
    log('loading model', { model: config.model, dtype: config.dtype });
    extractorPromise = pipeline('feature-extraction', config.model, {
      dtype: config.dtype as never,
    })
      .then((instance) => {
        log('model ready', { loadMs: Date.now() - started });
        return instance as FeatureExtractionPipeline;
      })
      .catch((error) => {
        // The reset is needed so the next attempt does not pull a rejected
        // promise out of the cache and turn the failure into a permanent one.
        extractorPromise = null;
        throw error;
      });
  }
  lastUsedAt = Date.now();
  return extractorPromise;
}

const idleTimer = setInterval(() => {
  if (extractorPromise === null) return;
  if (Date.now() - lastUsedAt < config.idleTimeoutMs) return;

  extractorPromise = null;
  log('released model after idle', { idleMs: config.idleTimeoutMs });
}, 60_000);
idleTimer.unref();

type Request =
  | { id: number; type: 'embed'; texts: string[] }
  | { id: number; type: 'shutdown' };

type Response =
  | { id: number; ok: true; payload: unknown }
  | { id: number; ok: false; error: string };

async function handle(request: Request): Promise<Response> {
  try {
    switch (request.type) {
      case 'embed': {
        if (request.texts.length === 0) {
          return { id: request.id, ok: true, payload: { vectors: [] as Float32Array[] } };
        }
        const extractor = await loadExtractor();
        if (extractor === null) throw new Error('model is not loaded');

        const output = await extractor(request.texts, { pooling: 'mean', normalize: true });
        const [, dimension] = output.dims;
        if (dimension === undefined) throw new Error(`unexpected dimensionality: ${output.dims.join('x')}`);

        const flat = output.data as Float32Array;
        const vectors: Float32Array[] = [];
        for (let i = 0; i < request.texts.length; i += 1) {
          vectors.push(flat.slice(i * dimension, (i + 1) * dimension));
        }
        return { id: request.id, ok: true, payload: { vectors } };
      }

      case 'shutdown': {
        extractorPromise = null;
        return { id: request.id, ok: true, payload: { closed: true } };
      }
    }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

parentPort?.on('message', (request: Request) => {
  void handle(request).then((response) => parentPort?.postMessage(response));
});

log('worker started', { model: config.model, cacheDir: config.cacheDir, offline: config.offline });
