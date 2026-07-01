const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

export function shouldHandleDialogEnter(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  const editable = target.closest('[contenteditable]');
  const contentEditable = (editable instanceof HTMLElement ? editable.getAttribute('contenteditable') : null) ?? target.contentEditable;
  if (
    target.isContentEditable
    || contentEditable === ''
    || contentEditable?.toLowerCase() === 'true'
    || contentEditable?.toLowerCase() === 'plaintext-only'
  ) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (tagName === 'button' || tagName === 'select' || tagName === 'textarea' || tagName === 'a' || tagName === 'summary') {
    return false;
  }

  if (tagName === 'input') {
    const type = (target as HTMLInputElement).type.toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }

  return !target.closest('button, a, summary, [role="button"], [role="menuitem"]');
}
