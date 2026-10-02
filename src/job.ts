import { createLogger } from './logger.js';

const log = createLogger('job');

export type JobPhase = 'idle' | 'scanning' | 'chunking' | 'embedding' | 'done' | 'failed';

export interface JobState {
  running: boolean;
  phase: JobPhase;
  done: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const idle = (): JobState => ({
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
});

let state: JobState = idle();
let current: Promise<void> | null = null;
let rerunRequested = false;

/**
 * Queues another pass when a job is already running.
 *
 * Needed for watcher events that land in the middle of an indexing run. Dropping
 * them is not an option: there will be no next pass unless further edits arrive,
 * the index stays stale, and index_status reports stale=0 — a failure the project
 * is not supposed to have.
 */
export function requestRerun(): void {
  // The flag is taken from state, not from current: the running job assigns
  // current only after run has been called, so the check on it would swallow the
  // request from the very first pass.
  if (state.running) rerunRequested = true;
}

export function jobState(): JobState {
  return { ...state };
}

/**
 * A long indexing run does not fit into one MCP tool call: the protocol has a
 * request timeout (60 s in the SDK) and the client would come out of it with an
 * error even though the work is going fine. So the start returns immediately and
 * the state is observed through index_status.
 */
export function startJob(
  run: (report: (phase: JobPhase, done: number, total: number) => void) => Promise<void>,
): { started: boolean } {
  if (current !== null) return { started: false };

  state = {
    running: true,
    phase: 'scanning',
    done: 0,
    total: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  const report = (phase: JobPhase, done: number, total: number) => {
    state = { ...state, phase, done, total };
  };

  current = run(report)
    .then(() => {
      state = { ...state, running: false, phase: 'done', done: state.total, finishedAt: new Date().toISOString() };
      log.info('job finished', { done: state.done, total: state.total });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      state = {
        ...state,
        running: false,
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: message,
      };
      log.error('job failed', { error: message });
    })
    .finally(() => {
      current = null;
      if (rerunRequested) {
        // The flag is cleared before the start: otherwise the pass it just
        // triggered would ask for another one and loop forever.
        rerunRequested = false;
        log.info('rerun requested during indexing, starting next pass');
        startJob(run);
      }
    });

  return { started: true };
}

export function resetJob(): void {
  state = idle();
  rerunRequested = false;
}
