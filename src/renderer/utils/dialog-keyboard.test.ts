// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldHandleDialogEnter } from './dialog-keyboard';

describe('shouldHandleDialogEnter', () => {
  it('allows Enter from plain text inputs', () => {
    const input = document.createElement('input');
    input.type = 'text';

    expect(shouldHandleDialogEnter(input)).toBe(true);
  });

  it('ignores controls with their own Enter behavior', () => {
    const button = document.createElement('button');
    const select = document.createElement('select');
    const textarea = document.createElement('textarea');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';

    expect(shouldHandleDialogEnter(button)).toBe(false);
    expect(shouldHandleDialogEnter(select)).toBe(false);
    expect(shouldHandleDialogEnter(textarea)).toBe(false);
    expect(shouldHandleDialogEnter(checkbox)).toBe(false);
  });

  it('ignores nested button-like controls', () => {
    const buttonLike = document.createElement('div');
    buttonLike.setAttribute('role', 'button');
    const child = document.createElement('span');
    buttonLike.appendChild(child);

    expect(shouldHandleDialogEnter(child)).toBe(false);
  });

  it('ignores contenteditable regions', () => {
    const editable = document.createElement('div');
    editable.contentEditable = 'true';

    expect(shouldHandleDialogEnter(editable)).toBe(false);
  });
});
