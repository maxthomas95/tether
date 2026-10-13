/**
 * Building blocks for the trackers that keep a session's child rows current
 * without watching files: single-flight refreshes, a debounced trigger, one
 * pending poll timer, change-only broadcasting and a bounded pool of viewer
 * readers.
 */

/** Runs `task` one at a time. A request made while it runs reruns it once afterwards. */
export class CoalescedRunner {
  private current: Promise<void> | null = null;
  private pending = false;

  constructor(
    private readonly task: () => Promise<void>,
    /** False once whatever the task refreshes is gone, so no rerun is started. */
    private readonly stillWanted: () => boolean,
  ) {}

  request(): Promise<void> {
    if (this.current) {
      this.pending = true;
      return this.current;
    }
    const finished = () => {
      this.current = null;
      if (!this.pending) return;
      this.pending = false;
      if (this.stillWanted()) void this.request();
    };
    this.current = this.task().finally(finished);
    return this.current;
  }
}

/** One timer that is never left running: arming replaces it, and it does not hold the process open. */
export class SingleTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;

  get armed(): boolean {
    return this.handle !== null;
  }

  arm(delayMs: number, fn: () => void): void {
    this.clear();
    this.handle = setTimeout(() => {
      this.handle = null;
      fn();
    }, delayMs);
    this.handle.unref?.();
  }

  clear(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = null;
  }
}

/** Calls `fn` once, `delayMs` after the first trigger of a burst. */
export class Debounce {
  private readonly timer = new SingleTimer();

  constructor(private readonly delayMs: number) {}

  trigger(fn: () => void): void {
    if (!this.timer.armed) this.timer.arm(this.delayMs, fn);
  }

  cancel(): void {
    this.timer.clear();
  }
}

/** Tells listeners about a list only when it differs from the last one sent for that key. */
export class ChangeBroadcaster<L> {
  private readonly listeners = new Set<(key: string, list: L) => void>();
  private readonly sent = new Map<string, string>();

  /** `blank` is what every key is taken to have been sent already, so an empty first list says nothing. */
  constructor(private readonly blank: L) {}

  subscribe(listener: (key: string, list: L) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(key: string, list: L): void {
    const signature = JSON.stringify(list);
    if (signature === (this.sent.get(key) ?? JSON.stringify(this.blank))) return;
    this.sent.set(key, signature);
    for (const listener of this.listeners) {
      try { listener(key, list); } catch { /* a bad listener must not stop polling */ }
    }
  }

  forget(key: string): void {
    this.sent.delete(key);
  }

  clear(): void {
    this.listeners.clear();
    this.sent.clear();
  }
}

/**
 * One reader per open viewer. A viewer that never released (renderer crash)
 * must not pin memory, so the oldest is dropped past `max`.
 */
export class ReaderPool<T> {
  private readonly readers = new Map<string, T>();

  constructor(private readonly max: number, private readonly make: () => T) {}

  get size(): number {
    return this.readers.size;
  }

  keys(): string[] {
    return [...this.readers.keys()];
  }

  claim(key: string): T {
    const held = this.readers.get(key);
    if (held) return held;
    const created = this.make();
    this.readers.set(key, created);
    for (const oldest of this.keys().slice(0, Math.max(0, this.readers.size - this.max))) this.readers.delete(oldest);
    return created;
  }

  release(key: string): void {
    this.readers.delete(key);
  }

  releasePrefix(prefix: string): void {
    for (const key of this.keys()) if (key.startsWith(prefix)) this.readers.delete(key);
  }

  clear(): void {
    this.readers.clear();
  }
}
