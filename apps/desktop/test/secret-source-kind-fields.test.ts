import { SECRET_SOURCE_KINDS } from '@wirebench/engine';
import { expect, it } from 'vitest';
import { KIND_FIELDS } from '../src/renderer/features/secret-sources/kind-fields.js';

it('lists the same kinds as the engine', () => {
  expect(
    Object.keys(KIND_FIELDS)
      .filter((kind) => kind !== 'none')
      .sort(),
  ).toEqual([...SECRET_SOURCE_KINDS].sort());
});
