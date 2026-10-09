import { expect, it } from 'vitest';
import * as ssh from '../../src/index.js';
it('the package loads', () => {
  expect(ssh).toBeDefined();
});
