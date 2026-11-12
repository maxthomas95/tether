import { describe, expect, it, vi } from 'vitest';
import { isTypedText, onPipActivity, reportPipActivity } from './pip-activity';

describe('Pip activity signal', () => {
  it('delivers text-free activity to current listeners only', () => {
    const first = vi.fn();
    const second = vi.fn();
    reportPipActivity('a');
    const stopFirst = onPipActivity(first);
    const stopSecond = onPipActivity(second);
    reportPipActivity('a');
    reportPipActivity('b', true);
    expect(first.mock.calls).toEqual([[{ sessionId: 'a', submitted: false }], [{ sessionId: 'b', submitted: true }]]);
    stopFirst();
    reportPipActivity('c');
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(3);
    stopSecond();
    reportPipActivity('d');
    expect(second).toHaveBeenCalledTimes(3);
  });

  it('finishes a delivery when a listener unsubscribes another', () => {
    const late = vi.fn();
    let stopLate = () => {};
    const stopEarly = onPipActivity(() => stopLate());
    stopLate = onPipActivity(late);
    reportPipActivity('a');
    reportPipActivity('a');
    expect(late).toHaveBeenCalledTimes(1);
    stopEarly();
  });

  it.each([
    ['plain text', 'hello', true],
    ['one character', 'a', true],
    ['a control character', '\x03', true],
    ['composed text', 'こんにちは', true],
    ['a bracketed paste', '\x1b[200~pasted\x1b[201~', true],
    ['nothing', '', false],
    ['focus in', '\x1b[I', false],
    ['focus out', '\x1b[O', false],
    ['a cursor position reply', '\x1b[12;40R', false],
    ['a device attributes reply', '\x1b[?1;2c', false],
    ['an SGR mouse report', '\x1b[<35;10;5M', false],
    ['a legacy mouse report', '\x1b[M !!', false],
    ['a colour query reply', '\x1b]11;rgb:0000/0000/0000\x1b\\', false],
    ['a wheel arrow sequence', '\x1b[A', false],
  ] as const)('classifies %s', (_name, data, typed) => expect(isTypedText(data)).toBe(typed));
});
