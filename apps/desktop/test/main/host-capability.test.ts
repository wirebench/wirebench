// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { requireCapability } from '../../src/main/host/capability.js';
import { createFakePlatform } from '../helpers/fake-platform.js';

describe('requireCapability', () => {
  it('returns the part the platform has', () => {
    const shell = {
      openExternal: () => Promise.resolve(),
      openPath: () => Promise.resolve(''),
      reveal: () => undefined,
      trash: () => Promise.resolve(),
    };
    expect(requireCapability(createFakePlatform({ shell }), 'shell')).toBe(shell);
  });

  it.each(['dialogs', 'shell', 'power'] as const)(
    'refuses with host-capability-missing when there is no %s',
    (part) => {
      try {
        requireCapability(createFakePlatform(), part);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(WirebenchError);
        expect((error as WirebenchError).code).toBe('host-capability-missing');
        expect((error as WirebenchError).details).toEqual({ capability: part });
      }
    },
  );
});
