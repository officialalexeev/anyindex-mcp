export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_NAMES = Object.keys(LEVEL_ORDER).join(', ');
let reportedUnknownLevel = false;

const threshold = (): number => {
  const raw = process.env.ANYINDEX_LOG_LEVEL?.trim();
  if (raw === undefined || raw === '') return LEVEL_ORDER.info;

  // Case-insensitive: `WARN` in a config file is the same request as `warn`, and
  // reading it as anything else would hand the user more output than they asked
  // for. An unknown value is named once instead of being swallowed — a typo here
  // looks exactly like a logger that ignores configuration.
  const level = LEVEL_ORDER[raw.toLowerCase() as LogLevel];
  if (level !== undefined) return level;

  if (!reportedUnknownLevel) {
    reportedUnknownLevel = true;
    process.stderr.write(
      `[logger] unknown ANYINDEX_LOG_LEVEL "${raw}", expected one of ${LEVEL_NAMES}; using info\n`,
    );
  }
  return LEVEL_ORDER.info;
};

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  if (LEVEL_ORDER[level] < threshold()) return;

  const line = `[${scope}] ${message}`;
  process.stderr.write(detail === undefined ? `${line}\n` : `${line} ${formatDetail(detail)}\n`);
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? detail.message;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, detail?: unknown) => emit('debug', scope, message, detail),
    info: (message: string, detail?: unknown) => emit('info', scope, message, detail),
    warn: (message: string, detail?: unknown) => emit('warn', scope, message, detail),
    error: (message: string, detail?: unknown) => emit('error', scope, message, detail),
  };
}

export type Logger = ReturnType<typeof createLogger>;