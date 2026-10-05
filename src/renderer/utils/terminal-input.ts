/** Win32-input-mode (DEC mode 9001) encodes Windows KEY_EVENT_RECORD fields.
 * VK_RETURN=13, scan=28, Unicode CR=13, SHIFT_PRESSED=16, repeat=1.
 * Pair press/release so the key never stays pressed when focus changes.
 */
export function encodeShiftEnter(win32InputMode: boolean): string {
  return win32InputMode
    ? '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_'
    : '\x1b[13;2u';
}
