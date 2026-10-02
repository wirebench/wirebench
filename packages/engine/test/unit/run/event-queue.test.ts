import { describe, expect, it } from 'vitest';
import { EventQueue } from '../../../src/run/event-queue.js';

describe('EventQueue', () => {
  it('yields what was pushed before and after iteration starts, then ends', async () => {
    const queue = new EventQueue<number>(true);
    queue.push(1);
    const seen: number[] = [];
    const reading = (async () => {
      for await (const n of queue) seen.push(n);
    })();
    queue.push(2);
    queue.end();
    queue.push(3);
    await reading;
    expect(seen).toEqual([1, 2]);
  });

  it('buffers nothing when disabled, and still ends', async () => {
    const queue = new EventQueue<number>(false);
    queue.push(1);
    queue.end();
    const seen: number[] = [];
    for await (const n of queue) seen.push(n);
    expect(seen).toEqual([]);
  });
});
