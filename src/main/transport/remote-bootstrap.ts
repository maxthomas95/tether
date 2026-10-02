import crypto from 'node:crypto';
import { quotePosixShellArg } from './posix-shell';

/** Secrets travel as stdin data consumed by read, never as interactive shell input.
 * The ready marker proves stty succeeded before any credential bytes are sent.
 * Short octal chunks handle multiline/UTF-8 values and PTY canonical line limits.
 * Output, including the passive OSC marker, remains untouched.
 */
export function buildRemoteBootstrap(command: string, exitAfterCommand = false) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const readyMarker = `\x1b]777;TETHER_READY=${nonce}\x07`;
  const endMarker = `TETHER_END_${nonce}`;
  const reader = [
    'set +x',
    'stty -echo || exit 1',
    `printf '\\033]777;TETHER_READY=${nonce}\\007'`,
    "tether_script=''",
    'while IFS= read -r tether_chunk; do',
    `  [ "$tether_chunk" = '${endMarker}' ] && break`,
    '  tether_script="$tether_script$(printf \'%b_\' "$tether_chunk")"',
    '  tether_script="${tether_script%_}"',
    'done',
    `[ "$tether_chunk" = '${endMarker}' ] || exit 1`,
    'stty echo || exit 1',
    'eval "$tether_script"',
  ].join('\n');
  const script = `unset tether_script tether_chunk; ${command}; tether_status=$?; ` +
    (exitAfterCommand ? 'exit "$tether_status"' : 'exec "${SHELL:-/bin/sh}" -l');
  const bytes = Buffer.from(script, 'utf8');
  if (bytes.length > 1024 * 1024) throw new Error('Remote launch configuration exceeds 1 MiB');
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 256) {
    lines.push(Array.from(bytes.subarray(offset, offset + 256), b => `\\0${b.toString(8).padStart(3, '0')}`).join(''));
  }
  return {
    command: `exec sh -c ${quotePosixShellArg(reader)}\n`,
    readyMarker,
    payload: `${lines.join('\n')}\n${endMarker}\n`,
  };
}
