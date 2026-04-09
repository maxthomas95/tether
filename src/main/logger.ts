import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATED = 2; // keep current + 2 rotated files

let logDir: string | null = null;
let logStream: fs.WriteStream | null = null;
let currentLevel: LogLevel = 'info';

function ensureLogDir(): string {
  if (!logDir) {
    logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }
  return logDir;
}

function getLogPath(): string {
  return path.join(ensureLogDir(), 'tether.log');
}

function rotateIfNeeded(): void {
  const logPath = getLogPath();
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // file doesn't exist yet
  }

  // Close current stream so we can rename
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  // Rotate: tether.2.log -> delete, tether.1.log -> tether.2.log, tether.log -> tether.1.log
  const dir = ensureLogDir();
  for (let i = MAX_ROTATED; i >= 1; i--) {
    const from = i === 1 ? getLogPath() : path.join(dir, `tether.${i - 1}.log`);
    const to = path.join(dir, `tether.${i}.log`);
    try {
      if (i === MAX_ROTATED) {
        fs.unlinkSync(to); // delete oldest
      }
    } catch { /* doesn't exist */ }
    try {
      fs.renameSync(from, to);
    } catch { /* doesn't exist */ }
  }
}

function getStream(): fs.WriteStream {
  if (!logStream) {
    rotateIfNeeded();
    logStream = fs.createWriteStream(getLogPath(), { flags: 'a' });
  }
  return logStream;
}

function formatMessage(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const prefix = `${timestamp} [${level.toUpperCase()}] [${category}]`;
  if (data && Object.keys(data).length > 0) {
    return `${prefix} ${message} ${JSON.stringify(data)}\n`;
  }
  return `${prefix} ${message}\n`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function write(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const formatted = formatMessage(level, category, message, data);
  try {
    getStream().write(formatted);
  } catch {
    // If logging itself fails, don't crash the app
  }
}

/** Create a scoped logger for a specific subsystem. */
export function createLogger(category: string) {
  return {
    error(message: string, data?: Record<string, unknown>) { write('error', category, message, data); },
    warn(message: string, data?: Record<string, unknown>) { write('warn', category, message, data); },
    info(message: string, data?: Record<string, unknown>) { write('info', category, message, data); },
    debug(message: string, data?: Record<string, unknown>) { write('debug', category, message, data); },
  };
}

/** Set the minimum log level. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Flush and close the log stream. Call on app shutdown. */
export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
