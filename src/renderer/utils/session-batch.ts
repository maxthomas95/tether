/**
 * Running one step per session, in order, for bulk actions (Restart all, Undo
 * of a clear or remove). Steps are awaited one at a time on purpose: creating
 * a session can stop to ask for a Vault login, and that prompt has one slot.
 */

export type BatchStepResult =
  | { status: 'done' }
  /** The user declined something the step needed (a Vault login). */
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown };

export interface BatchResult<T> {
  done: T[];
  failed: Array<{ item: T; error: unknown }>;
  /** Not attempted because an earlier step was cancelled. */
  skipped: T[];
}

/**
 * Run `step` for each item in turn. A failed step is recorded and the batch
 * carries on; a cancelled step stops it, and that item and the rest are
 * reported as skipped so the caller can offer them again.
 */
export async function runBatch<T>(
  items: readonly T[],
  step: (item: T) => Promise<BatchStepResult>,
): Promise<BatchResult<T>> {
  const result: BatchResult<T> = { done: [], failed: [], skipped: [] };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    let outcome: BatchStepResult;
    try {
      outcome = await step(item);
    } catch (error) {
      outcome = { status: 'failed', error };
    }
    if (outcome.status === 'done') {
      result.done.push(item);
    } else if (outcome.status === 'failed') {
      result.failed.push({ item, error: outcome.error });
    } else {
      result.skipped.push(...items.slice(index));
      break;
    }
  }
  return result;
}

export interface BatchSummary {
  type: 'info' | 'warning' | 'error';
  title: string;
  message?: string;
}

function plural(count: number): string {
  return `${count} session${count === 1 ? '' : 's'}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * The real outcome of a bulk action, for a toast: "Restarted 3 sessions", or
 * "Restarted 3 of 4 sessions" with the failed and skipped labels. `leftover`
 * says what became of the ones that did not go through.
 */
export function summarizeBatch(
  verb: string,
  result: BatchResult<{ label: string }>,
  leftover: string,
): BatchSummary {
  const total = result.done.length + result.failed.length + result.skipped.length;
  if (result.failed.length === 0 && result.skipped.length === 0) {
    return { type: 'info', title: `${verb} ${plural(total)}` };
  }
  const parts: string[] = [];
  if (result.failed.length > 0) {
    const names = result.failed.map(({ item, error }) => {
      const reason = errorText(error);
      return reason ? `${item.label} (${reason})` : item.label;
    });
    parts.push(`${result.failed.length} failed: ${names.join(', ')}.`);
  }
  if (result.skipped.length > 0) {
    parts.push(`${result.skipped.length} not attempted: ${result.skipped.map(item => item.label).join(', ')}.`);
  }
  parts.push(leftover);
  return {
    type: result.done.length === 0 ? 'error' : 'warning',
    title: `${verb} ${result.done.length} of ${plural(total)}`,
    message: parts.join(' '),
  };
}
