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
});
