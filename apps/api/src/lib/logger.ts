import { env, isTest } from '../config/env.js';

/**
 * Structured JSON logging.
 *
 * One line per event, machine-parseable, with a redaction pass that runs on
 * every log call. We deliberately did not pull in pino: the whole logger is 80
 * lines, and owning the redaction rules outright is the point - this app
 * handles health data and PII, so "what can reach the log stream" must be a
 * decision we can read in one file.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/** Keys whose values are replaced wholesale. */
const REDACT_KEYS = new Set([
  'email',
  'phone',
  'first_name',
  'last_name',
  'access_token',
  'token',
  'authorization',
  'password',
  'secret',
  'fbc',
  'fbp',
  'fbclid',
  'em',
  'ph',
  'fn',
  'ln',
]);

/**
 * Keys that contain qualification answers. Health information must never enter
 * the log stream, not even at debug level.
 */
const DROP_KEYS = new Set(['answers', 'accepted', 'qualification_reasons']);

function redactValue(value: unknown): unknown {
  if (typeof value !== 'string') return '[redacted]';
  if (value.length <= 4) return '[redacted]';
  // Keep a short suffix so two different values are distinguishable in a trace
  // without the value itself being recoverable.
  return `[redacted:${value.slice(-2)}]`;
}

export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[max-depth]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => redact(item, depth + 1));
  if (typeof input !== 'object') return input;
  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (DROP_KEYS.has(lower)) {
      out[key] = Array.isArray(value)
        ? `[${value.length} items omitted]`
        : `[${Object.keys(value ?? {}).length} keys omitted]`;
      continue;
    }
    if (REDACT_KEYS.has(lower)) {
      out[key] = redactValue(value);
      continue;
    }
    out[key] = redact(value, depth + 1);
  }
  return out;
}

export interface LogContext {
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, context: LogContext = {}): void {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;
  // Tests stay quiet unless something actually went wrong.
  if (isTest && LEVELS[level] < LEVELS.warn) return;

  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(redact(context) as LogContext),
  };

  const serialised = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialised}\n`);
  else process.stdout.write(`${serialised}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext) => write('debug', message, context),
  info: (message: string, context?: LogContext) => write('info', message, context),
  warn: (message: string, context?: LogContext) => write('warn', message, context),
  error: (message: string, context?: LogContext) => write('error', message, context),
  /** Returns a logger that stamps every line with the same base context. */
  child(base: LogContext) {
    return {
      debug: (m: string, c?: LogContext) => write('debug', m, { ...base, ...c }),
      info: (m: string, c?: LogContext) => write('info', m, { ...base, ...c }),
      warn: (m: string, c?: LogContext) => write('warn', m, { ...base, ...c }),
      error: (m: string, c?: LogContext) => write('error', m, { ...base, ...c }),
    };
  },
};

export type Logger = typeof logger;
