import { describe, expect, it } from 'vitest';
import { mapInsomnia } from '../../../../src/import/insomnia/map.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import { insomniaFixture } from './fixtures.js';

/** The whole mapped result, with ids numbered in creation order, so any change to it shows. */
function golden(name: string): unknown {
  let n = 0;
  return mapInsomnia(parseInsomnia(insomniaFixture(name)), { newId: () => `id-${String((n += 1))}` });
}

describe('Insomnia golden', () => {
  it.each(['v5-collection.yaml', 'v4.json'])('maps %s', (name) => {
    expect(golden(name)).toMatchSnapshot();
  });
});
