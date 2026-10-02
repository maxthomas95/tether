/** Decode only the framed launch data in transport mock assertions. */
export function decodeLaunchPayload(writes: unknown[][]): string {
  const octal = writes.map(call => String(call[0])).filter(text => text.startsWith('\\0'))
    .join('').split(/TETHER_END_[a-f0-9]+/)[0];
  return Buffer.from(Array.from(octal.matchAll(/\\0([0-7]{3})/g), match => parseInt(match[1], 8))).toString('utf8');
}

export function bootstrapReady(command: string): string | null {
  const nonce = command.match(/TETHER_READY=([a-f0-9]{32})/)?.[1];
  return nonce ? `\x1b]777;TETHER_READY=${nonce}\x07` : null;
}
