// Lazy loader for `node-pty`. Kept in its own module so tests can swap it via
// `vi.mock('./pty-loader')` without touching Node's CJS resolver — Vitest's
// `vi.mock` only intercepts ESM-style relative imports, not raw `require()`
// calls inside transformed CJS output.

let ptyModule: typeof import('node-pty') | null = null;

export function loadPty(): typeof import('node-pty') {
  if (!ptyModule) {
    ptyModule = require('node-pty');
  }
  return ptyModule!;
}
