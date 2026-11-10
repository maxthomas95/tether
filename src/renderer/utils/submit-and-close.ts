/** Run a dialog submit action and close only after it reports success. */
export async function submitAndClose(
  submit: () => Promise<boolean>,
  onSuccess: () => void,
): Promise<boolean> {
  const succeeded = await submit();
  if (succeeded) onSuccess();
  return succeeded;
}
