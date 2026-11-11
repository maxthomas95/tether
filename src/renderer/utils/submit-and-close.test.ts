import { expect, it, vi } from 'vitest';
import { submitAndClose } from './submit-and-close';

it('keeps a dialog open when submission reports failure', async () => {
  const onSuccess = vi.fn();

  await expect(submitAndClose(async () => false, onSuccess)).resolves.toBe(false);

  expect(onSuccess).not.toHaveBeenCalled();
});

it('closes a dialog when submission reports success', async () => {
  const onSuccess = vi.fn();

  await expect(submitAndClose(async () => true, onSuccess)).resolves.toBe(true);

  expect(onSuccess).toHaveBeenCalledOnce();
});
