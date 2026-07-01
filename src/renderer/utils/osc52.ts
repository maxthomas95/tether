/**
 * OSC 52 is the terminal escape sequence a program uses to put text on the
 * *host* clipboard (`ESC ] 52 ; Pc ; Pd BEL`). It's the only copy path that
 * works over SSH/Coder, where the remote CLI can't reach the local clipboard
 * directly — Claude Code's full-screen rendering relies on it.
 */

/**
 * Decode the payload of an OSC 52 clipboard sequence. xterm.js hands an OSC
 * handler everything after `52;` — i.e. `Pc;Pd`, where `Pc` is the target
 * selection (`c`, `p`, …) and `Pd` is the base64-encoded text.
 *
 * Returns the decoded UTF-8 text, or `null` for read requests (`Pd === '?'`)
 * and malformed payloads.
 *
 * Write-only by design: we never answer OSC 52 *read* requests. Honoring them
 * would let a program running in the PTY exfiltrate the local clipboard back
 * over the (possibly remote) session.
 */
export function decodeOsc52Write(data: string): string | null {
  const sep = data.indexOf(';');
  const payload = sep === -1 ? data : data.slice(sep + 1);
  if (!payload || payload === '?') return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
