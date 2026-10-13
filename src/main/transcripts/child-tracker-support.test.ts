import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeBroadcaster, CoalescedRunner, Debounce, ReaderPool, SingleTimer } from './child-tracker-support';

afterEach(() => { vi.useRealTimers(); });

describe('CoalescedRunner', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  };

  it('runs one task at a time and reruns once for any number of requests made meanwhile', async () => {
    const gates = [deferred(), deferred()];
    let runs = 0;
    const runner = new CoalescedRunner(() => gates[runs++].promise, () => true);
    const first = runner.request();
    void runner.request();
    void runner.request();
    expect(runs).toBe(1);
    gates[0].resolve();
    await first;
    await Promise.resolve();
    expect(runs).toBe(2);
    gates[1].resolve();
    await vi.waitFor(() => expect(runs).toBe(2));
  });

  it('gives a request made during a run the run already in flight', async () => {
    const gate = deferred();
    const runner = new CoalescedRunner(() => gate.promise, () => true);
    const a = runner.request();
    expect(runner.request()).toBe(a);
    gate.resolve();
    await a;
  });

  it('does not rerun when what it refreshes is gone', async () => {
    const gate = deferred();
    let runs = 0;
    let wanted = true;
    const runner = new CoalescedRunner(() => { runs++; return gate.promise; }, () => wanted);
    const run = runner.request();
    void runner.request();
    wanted = false;
    gate.resolve();
    await run;
    await Promise.resolve();
    expect(runs).toBe(1);
  });

  it('can run again after a task rejects', async () => {
    let runs = 0;
    const runner = new CoalescedRunner(async () => { if (runs++ === 0) throw new Error('boom'); }, () => true);
    await expect(runner.request()).rejects.toThrow('boom');
    await runner.request();
    expect(runs).toBe(2);
  });
});

describe('SingleTimer and Debounce', () => {
  it('arming replaces a pending timer, and clearing stops it', () => {
    vi.useFakeTimers();
    const timer = new SingleTimer();
    const fn = vi.fn();
    timer.arm(100, fn);
    expect(timer.armed).toBe(true);
    timer.arm(100, fn);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(timer.armed).toBe(false);
    timer.arm(100, fn);
    timer.clear();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires once for a burst, measured from its first trigger, and can be cancelled', () => {
    vi.useFakeTimers();
    const debounce = new Debounce(750);
    const fn = vi.fn();
    debounce.trigger(fn);
    vi.advanceTimersByTime(500);
    debounce.trigger(fn);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
    debounce.trigger(fn);
    debounce.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('ChangeBroadcaster', () => {
  it('says nothing for the blank list, then only when a key changes', () => {
    const feed = new ChangeBroadcaster<{ n: number }>({ n: 0 });
    const heard = vi.fn();
    feed.subscribe(heard);
    feed.publish('a', { n: 0 });
    feed.publish('a', { n: 1 });
    feed.publish('a', { n: 1 });
    feed.publish('b', { n: 1 });
    expect(heard.mock.calls).toEqual([['a', { n: 1 }], ['b', { n: 1 }]]);
    feed.forget('a');
    feed.publish('a', { n: 1 });
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('keeps notifying the others when a listener throws, and stops after unsubscribe or clear', () => {
    const feed = new ChangeBroadcaster<number>(0);
    const good = vi.fn();
    feed.subscribe(() => { throw new Error('bad listener'); });
    const off = feed.subscribe(good);
    feed.publish('k', 1);
    expect(good).toHaveBeenCalledTimes(1);
    off();
    feed.publish('k', 2);
    expect(good).toHaveBeenCalledTimes(1);
    feed.clear();
    feed.publish('k', 3);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('ReaderPool', () => {
  it('hands the same reader to the same key and drops the oldest past its size', () => {
    let made = 0;
    const pool = new ReaderPool(3, () => ({ id: ++made }));
    const a = pool.claim('a');
    expect(pool.claim('a')).toBe(a);
    pool.claim('b');
    pool.claim('c');
    pool.claim('d');
    expect(pool.keys()).toEqual(['b', 'c', 'd']);
    expect(pool.size).toBe(3);
  });

  it('releases one key, a prefix, or everything', () => {
    const pool = new ReaderPool(10, () => ({}));
    for (const key of ['s1:a', 's1:b', 's2:a']) pool.claim(key);
    pool.release('s1:a');
    expect(pool.keys()).toEqual(['s1:b', 's2:a']);
    pool.releasePrefix('s1:');
    expect(pool.keys()).toEqual(['s2:a']);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});
