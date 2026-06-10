import { createLogger } from './logger';

const log = createLogger('process-guards');

let installed = false;

/**
 * Install global process-level error handlers for the Electron main process.
 *
 * Call this as early as possible in the entry point — before app.whenReady()
 * and before any subsystem initialises — so that errors thrown during startup
 * are captured too.
 *
 * Idempotent: calling more than once is a no-op.
 */
export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason: unknown) => {
    const message =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : String(reason);
    log.error('Unhandled promise rejection', { reason: message });
    // Do NOT exit — a stray rejection in an async path (SSH verification,
    // vault resolution, transcript watching, etc.) must not kill every live PTY.
  });

  // NOTE: Node's default behaviour on uncaughtException is to print the error
  // and exit with code 1. We deliberately deviate from that here because
  // Tether's primary value is keeping long-running PTY sessions alive. A crash
  // in one subsystem should degrade that subsystem, not terminate every open
  // terminal. The error is logged so it can be inspected in the log file.
  process.on('uncaughtException', (err: Error) => {
    log.error('Uncaught exception', { message: err.message, stack: err.stack ?? '' });
    // Do NOT exit — PTY survival takes priority over Node's crash-fast default.
  });
}
