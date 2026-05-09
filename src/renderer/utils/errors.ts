const IPC_ERROR_RE = /Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.*)$/s;
const MAX_ERROR_MESSAGE_LENGTH = 1200;
const SECRET_ASSIGNMENT_RE = /\b((?:api[_-]?key|token|secret|password)[^:=\n\r]*[:=]\s*)([^\s,;]+)/gi;

export function sanitizeErrorMessage(message: string): string {
  const redacted = message.replace(SECRET_ASSIGNMENT_RE, '$1[redacted]');
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

export function extractErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(IPC_ERROR_RE);
  return sanitizeErrorMessage((match ? match[1] : raw).trim());
}

export function formatSessionExitMessage(exitCode: number, detail?: string): string {
  const base = `Session exited with code ${exitCode}.`;
  if (!detail?.trim()) return base;
  return `${base}\n${sanitizeErrorMessage(detail.trim())}`;
}
