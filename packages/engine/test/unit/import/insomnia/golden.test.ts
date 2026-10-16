import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapInsomnia } from '../../../../src/import/insomnia/map.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, '../../../../../../fixtures/insomnia/crafted/v5-collection.yaml');

function counter(): () => string {
  let n = 0;
  return () => `id-${String((n += 1))}`;
}

describe('mapInsomnia golden', () => {
  it('maps the crafted v5 collection', () => {
    const mapped = mapInsomnia(parseInsomnia(readFileSync(fixture, 'utf8')), { newId: counter() });
    expect(mapped).toMatchSnapshot();
  });
});
