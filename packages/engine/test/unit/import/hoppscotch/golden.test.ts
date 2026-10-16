import { describe, expect, it } from 'vitest';
import { hoppscotchEnvironmentPlan, mapHoppscotch } from '../../../../src/import/hoppscotch/convert.js';
import { parseHoppscotchCollections, parseHoppscotchEnvironments } from '../../../../src/import/hoppscotch/parse.js';
import { hoppscotchFixture } from './fixtures.js';

/** Ids numbered in creation order, so the whole mapped result is stable and any change to it shows. */
function numbered(): { newId: () => string } {
  let n = 0;
  return { newId: () => `id-${String((n += 1))}` };
}

describe('Hoppscotch golden', () => {
  for (const name of ['v12-r17.json', 'legacy-v0.json', 'mixed-versions.json', 'gql.json']) {
    it(`maps ${name}`, () => {
      const { collections, report } = parseHoppscotchCollections(hoppscotchFixture(name));
      expect(mapHoppscotch(collections, report, numbered())).toMatchSnapshot();
    });
  }

  it('maps the environments fixture', () => {
    const { environments, report } = parseHoppscotchEnvironments(hoppscotchFixture('environments-v2.json'));
    expect(hoppscotchEnvironmentPlan(environments, report)).toMatchSnapshot();
  });
});
