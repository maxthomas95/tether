// Lazy loader for `ssh2`. Same rationale as `pty-loader.ts` — gives tests an
// ESM-relative target for `vi.mock` instead of a CJS `require()` call inside
// the transport itself.

let ssh2Module: typeof import('ssh2') | null = null;

export function loadSsh2(): typeof import('ssh2') {
  if (!ssh2Module) {
    ssh2Module = require('ssh2');
  }
  return ssh2Module!;
}
