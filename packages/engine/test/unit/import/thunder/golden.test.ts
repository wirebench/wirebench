import { describe, expect, it } from 'vitest';
import { mapThunderClient } from '../../../../src/import/thunder/convert.js';
import { readThunderFolder } from '../../../../src/import/thunder/import.js';
import { parseThunderExport, parseThunderFolder } from '../../../../src/import/thunder/parse.js';
import { thunderFixture, thunderFixtureDir } from './fixtures.js';

/** Ids numbered in creation order, so the whole mapped result is stable and any change to it shows. */
function numbered(): { newId: () => string } {
  let n = 0;
  return { newId: () => `id-${String((n += 1))}` };
}

describe('Thunder Client golden', () => {
  for (const name of [
    'collection-1.2.json',
    'collection-1.0.json',
    'environment-1.0.json',
    'environment-1.2-global.json',
  ]) {
    it(`maps ${name}`, () => {
      expect(mapThunderClient(parseThunderExport(thunderFixture(name)), numbered())).toMatchSnapshot();
    });
  }

  for (const name of ['folder-v3', 'folder-legacy']) {
    it(`maps the ${name} folder`, async () => {
      const files = await readThunderFolder(`${thunderFixtureDir}${name}`);
      expect(mapThunderClient(parseThunderFolder(files), numbered())).toMatchSnapshot();
    });
  }
});
