import { describe, expect, it } from 'vitest';
import { defaultRegistry } from '../../../src/protocols.js';

describe('defaultRegistry', () => {
  it('is the built-in registry with every feature on, the same one each time', () => {
    expect(defaultRegistry()).toBe(defaultRegistry());
    for (const kind of ['soap', 'rest', 'grpc', 'websocket', 'mcp']) {
      expect(defaultRegistry().status(kind), kind).toBe('enabled');
    }
  });
});
