import { JWT_ALGORITHMS } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { JWT_ALGORITHM_NAMES } from '../src/shared/jwt-algorithms.js';

describe('JWT_ALGORITHM_NAMES', () => {
  it("is the engine's list, which the renderer cannot import", () => {
    expect([...JWT_ALGORITHM_NAMES]).toEqual([...JWT_ALGORITHMS]);
  });
});
