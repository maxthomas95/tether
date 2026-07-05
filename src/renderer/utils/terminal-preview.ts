/**
 * Extracts the last few non-empty logical lines from an xterm.js buffer for
 * the sidebar hover preview. Pure and dependency-free so it can be unit
 * tested without spinning up a real `Terminal` instance — callers pass
 * `terminal.buffer.active`, which satisfies `PreviewBuffer` structurally.
 */

/** The subset of xterm.js's `IBufferLine` this module reads. */
export interface PreviewBufferLine {
  translateToString(trimRight?: boolean): string;
  isWrapped: boolean;
}

/** The subset of xterm.js's `IBuffer` this module reads. */
export interface PreviewBuffer {
  length: number;
  getLine(y: number): PreviewBufferLine | undefined;
}

/** Cap on a single merged (wrap-joined) logical line, in characters. */
const MAX_LOGICAL_LINE_LENGTH = 400;

/**
 * Walk `buffer` from the bottom up, merging wrapped continuation rows into
 * their logical line (`isWrapped` marks a row as the continuation of the row
 * above it), and return the last `maxLines` non-empty logical lines in
 * top-to-bottom order. Blank lines — trailing or in between — are skipped
 * rather than counted, so the result is always up to `maxLines` lines of
 * actual content.
 */
export function readLastLines(buffer: PreviewBuffer, maxLines: number): string[] {
  const result: string[] = [];
  let row = buffer.length - 1;

  while (row >= 0 && result.length < maxLines) {
    // Find the top of the wrapped group ending at `row`.
    let start = row;
    while (start > 0 && buffer.getLine(start)?.isWrapped) {
      start--;
    }

    let text = '';
    for (let r = start; r <= row; r++) {
      text += buffer.getLine(r)?.translateToString(true) ?? '';
      if (text.length > MAX_LOGICAL_LINE_LENGTH) {
        text = text.slice(0, MAX_LOGICAL_LINE_LENGTH);
        break;
      }
    }

    if (text.trim().length > 0) {
      result.unshift(text);
    }

    row = start - 1;
  }

  return result;
}
