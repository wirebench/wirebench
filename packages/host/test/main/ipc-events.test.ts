// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '@wirebench/wire/ipc-contract';
import { emitEvent } from '../../src/ipc/events.js';
import { fakeCaller } from '../helpers/fake-platform.js';

const ping = defineEvent('test.ping', z.object({ n: z.number() }));

describe('emitEvent', () => {
  it('sends the validated payload to the caller', () => {
    const caller = fakeCaller();
    emitEvent(caller, ping, { n: 1 });
    expect(caller.sent).toEqual([['test.ping', { n: 1 }]]);
  });

  it('sends nothing to a closed caller, and does not throw', () => {
    const caller = fakeCaller();
    caller.close();
    expect(() => {
      emitEvent(caller, ping, { n: 1 });
    }).not.toThrow();
    expect(caller.sent).toEqual([]);
  });

  it('still throws on an invalid payload, even for a closed caller', () => {
    const caller = fakeCaller();
    expect(() => {
      emitEvent(caller, ping, { n: 'x' } as never);
    }).toThrow(/ipc-invalid-event|Invalid event payload/);
    caller.close();
    expect(() => {
      emitEvent(caller, ping, { n: 'x' } as never);
    }).toThrow(/Invalid event payload/);
  });
});
