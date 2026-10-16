import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ocOfBrunoFolder } from '../../../../src/import/bruno/convert.js';
import { mapBruno } from '../../../../src/import/bruno/import.js';
import { ocOfBrunoExport } from '../../../../src/import/bruno/json-export.js';
import { brunoFiles, brunoFixtureDir } from './fixtures.js';

/** Ids numbered in creation order, so the whole mapped result is stable and any change to it shows. */
function numbered(): { newId: () => string } {
  let n = 0;
  return { newId: () => `id-${String((n += 1))}` };
}

describe('Bruno golden', () => {
  it('maps the folder fixture', () => {
    const { collection, report } = ocOfBrunoFolder(brunoFiles(), 'basic');
    expect(mapBruno(collection, report, numbered())).toMatchSnapshot();
  });

  it('maps the JSON export fixture', () => {
    const json: unknown = JSON.parse(readFileSync(join(brunoFixtureDir, 'export.json'), 'utf8'));
    const { collection, report } = ocOfBrunoExport(json);
    expect(mapBruno(collection, report, numbered())).toMatchSnapshot();
  });
});
