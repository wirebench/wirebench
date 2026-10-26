// @vitest-environment node
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakePlatform, fakeCaller } from '../helpers/fake-platform.js';

describe('createFakePlatform', () => {
  it('gives each platform its own userData under the OS temp directory', () => {
    const a = createFakePlatform().paths.userData();
    const b = createFakePlatform().paths.userData();
    expect(a).not.toBe(b);
    expect(dirname(a)).toBe(tmpdir());
  });

  it('honours overrides', () => {
    expect(createFakePlatform({ userData: '/x' }).paths.userData()).toBe('/x');
    expect(createFakePlatform({ capabilities: new Set(['files']) }).capabilities.has('ssh')).toBe(false);
  });
});

describe('fakeCaller', () => {
  it('records sends until closed, then ignores them', () => {
    const caller = fakeCaller(3);
    const closed = vi.fn();
    caller.onClosed(closed);
    caller.send('a', 1);
    caller.close();
    caller.send('b', 2);
    expect(caller.id).toBe(3);
    expect(caller.isClosed()).toBe(true);
    expect(caller.sent).toEqual([['a', 1]]);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('runs a listener added after close once, in a microtask, and lets it be cancelled first', async () => {
    const caller = fakeCaller();
    caller.close();
    const late = vi.fn();
    caller.onClosed(late);
    caller.onClosed(vi.fn())();
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('keeps telling the other listeners when one throws', () => {
    const caller = fakeCaller();
    const after = vi.fn();
    caller.onClosed(() => {
      throw new Error('boom');
    });
    caller.onClosed(after);
    expect(() => {
      caller.close();
    }).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('tells reset listeners when reset, until they unsubscribe', () => {
    const caller = fakeCaller();
    const reset = vi.fn();
    const off = caller.onReset(reset);
    caller.reset();
    off();
    caller.reset();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(caller.isClosed()).toBe(false);
  });
});
