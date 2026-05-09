const MAX_ERROR_MESSAGE_LENGTH = 1200;
const SECRET_ASSIGNMENT_RE = /\b((?:api[_-]?key|token|secret|password)[^:=\n\r]*[:=]\s*)([^\s,;]+)/gi;
const IPC_ERROR_PREFIX = "Error invoking remote method '";
const IPC_ERROR_SEPARATOR = "':";
const ERROR_LABEL = 'Error:';

export function sanitizeErrorMessage(message: string): string {
  const redacted = message.replace(SECRET_ASSIGNMENT_RE, '$1[redacted]');
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

export function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return sanitizeErrorMessage(stripIpcErrorPrefix(raw).trim());
}

export function formatSessionExitMessage(exitCode: number, detail?: string): string {
  const base = `Session exited with code ${exitCode}.`;
  if (!detail?.trim()) return base;
  return `${base}\n${sanitizeErrorMessage(detail.trim())}`;
}

function stripIpcErrorPrefix(message: string): string {
  if (!message.startsWith(IPC_ERROR_PREFIX)) return message;
  const separatorIndex = message.indexOf(IPC_ERROR_SEPARATOR, IPC_ERROR_PREFIX.length);
  if (separatorIndex === -1) return message;

  const detailStart = separatorIndex + IPC_ERROR_SEPARATOR.length;
  const detail = message.slice(detailStart).trimStart();
  return detail.startsWith(ERROR_LABEL)
    ? detail.slice(ERROR_LABEL.length).trimStart()
    : detail;
}
