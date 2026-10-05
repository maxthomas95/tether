interface RestoreCallbacks {
  isMounted(): boolean;
  onReady(): void;
  onError(error: unknown): void;
}

/** Open workspace persistence only after initialization has safely completed. */
export async function initializeWorkspace(restore: () => Promise<void>, callbacks: RestoreCallbacks): Promise<void> {
  try {
    await restore();
  } catch (error) {
    if (callbacks.isMounted()) callbacks.onError(error);
    return;
  }
  if (callbacks.isMounted()) callbacks.onReady();
}
