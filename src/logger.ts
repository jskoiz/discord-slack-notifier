/* eslint-disable */
declare const process: any;

type Level = 'error' | 'info' | 'debug';

const LEVELS: Record<Level, number> = { error: 0, info: 1, debug: 2 };
const envLevel = (process.env.LOG_LEVEL || 'info').toString().toLowerCase();
const CURRENT = (LEVELS[(envLevel as Level)] ?? LEVELS.info) as number;

const LOG_FORMAT = (process.env.LOG_FORMAT || 'text').toString().toLowerCase();
const HEARTBEAT_MS = Number(process.env.LOG_HEARTBEAT_MS ?? '0');

function isoNow(): string {
  return new Date().toISOString();
}

function formatText(level: string, msg: string): string {
  return `${level.toUpperCase()}: [${isoNow()}] ${msg}`;
}

function formatJson(level: string, msg: string): string {
  try {
    return JSON.stringify({ level: level.toLowerCase(), ts: isoNow(), msg });
  } catch {
    return formatText(level, msg);
  }
}

function writeStdout(s: string): void {
  try {
    // keep info/debug on stdout
    console.log(s);
  } catch {
    // swallow - logging should never throw
  }
}

function writeStderr(s: string): void {
  try {
    // errors on stderr
    console.error(s);
  } catch {
    // swallow
  }
}

function shouldLog(l: Level): boolean {
  return LEVELS[l] <= CURRENT;
}

export function info(message: string): void {
  try {
    if (!shouldLog('info')) return;
    const out = LOG_FORMAT === 'json' ? formatJson('info', message) : formatText('info', message);
    writeStdout(out);
  } catch {
    // swallow
  }
}

export function debug(message: string): void {
  try {
    if (!shouldLog('debug')) return;
    const out = LOG_FORMAT === 'json' ? formatJson('debug', message) : formatText('debug', message);
    writeStdout(out);
  } catch {
    // swallow
  }
}

export function error(message: string): void {
  try {
    // always log errors regardless of level
    const out = LOG_FORMAT === 'json' ? formatJson('error', message) : formatText('error', message);
    writeStderr(out);
  } catch {
    // swallow
  }
}

/*
  Optional lightweight heartbeat. If LOG_HEARTBEAT_MS > 0 a periodic INFO-level
  heartbeat will be emitted. This is intentionally minimal and defensive.
*/
if (HEARTBEAT_MS > 0) {
  try {
    setInterval(() => {
      try {
        const msg = `heartbeat: running`;
        if (shouldLog('info')) {
          const out = LOG_FORMAT === 'json' ? formatJson('info', msg) : formatText('info', msg);
          writeStdout(out);
        }
      } catch {
        // swallow
      }
    }, HEARTBEAT_MS);
  } catch {
    // swallow
  }
}