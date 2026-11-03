/** The entry's queue (hosted edition spec §21.4): after the answer, one at a time, bounded, naming no address. */
import { describe, expect, it, vi } from 'vitest';
import { EntryQueue } from '../../../src/entry/queue.js';
import { addressBucketKey } from '../../../src/entry/routes.js';

const log = () => ({ warn: vi.fn(), error: vi.fn() });

describe('EntryQueue', () => {
  it('runs nothing before the caller has returned, then each address in turn, one at a time', async () => {
    const seen: string[] = [];
    let running = 0;
    let most = 0;
    const queue = new EntryQueue({
      log: log(),
      run: async (address) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(address);
        running--;
      },
    });
    queue.push('a@x.test');
    queue.push('b@x.test');
    expect(seen).toEqual([]);
    await queue.idle();
    expect(seen).toEqual(['a@x.test', 'b@x.test']);
    expect(most).toBe(1);
  });

  it('drops past its limit with a warning that names no address', async () => {
    const l = log();
    let release: () => void = () => undefined;
    const queue = new EntryQueue({
      log: l,
      limit: 2,
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    expect(queue.push('a@x.test')).toBe(true);
    expect(queue.push('b@x.test')).toBe(true);
    expect(queue.push('c@x.test')).toBe(false);
    expect(l.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(l.warn.mock.calls)).not.toContain('@');
    await vi.waitFor(() => {
      expect(queue.size).toBe(1);
    });
    release();
    await vi.waitFor(() => {
      expect(queue.size).toBe(0);
    });
    release();
    await queue.idle();
  });

  it('keeps going after a run fails, and logs the error only', async () => {
    const l = log();
    const seen: string[] = [];
    const queue = new EntryQueue({
      log: l,
      run: (address) => {
        if (address.startsWith('bad')) return Promise.reject(new Error('mail host down'));
        seen.push(address);
        return Promise.resolve();
      },
    });
    queue.push('bad@x.test');
    queue.push('good@x.test');
    await queue.idle();
    expect(seen).toEqual(['good@x.test']);
    expect(l.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(l.error.mock.calls)).not.toContain('bad@x.test');
  });

  it('drops what waits on close and refuses more', async () => {
    const queue = new EntryQueue({ log: log(), run: () => Promise.resolve() });
    queue.push('a@x.test');
    await queue.close();
    expect(queue.push('b@x.test')).toBe(false);
    expect(queue.size).toBe(0);
  });
});

describe('addressBucketKey', () => {
  it('never holds the address', () => {
    const key = addressBucketKey(Buffer.alloc(32, 1), 'someone@acme.test');
    expect(key).not.toContain('someone');
    expect(key).toBe(addressBucketKey(Buffer.alloc(32, 1), 'someone@acme.test'));
    expect(key).not.toBe(addressBucketKey(Buffer.alloc(32, 2), 'someone@acme.test'));
  });
});
