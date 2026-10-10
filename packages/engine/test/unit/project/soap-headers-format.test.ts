import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { tempProjectDir } from './fixture.js';
import { soapInterfacesOf } from '../../../src/soap/model.js';

const V3_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v3', 'project');
const SMOKE = join('interfaces', 'CountryInfo', 'operations', 'ListOfCountryNamesByCode', 'Smoke test.request.yaml');

describe('SOAP request headers on file', () => {
  it('load and save a header switched off and a description, and leave plain rows plain', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const file = join(dir, SMOKE);
    const original = await readFile(file, 'utf8');
    await writeFile(
      file,
      original.replace(
        'headers:\n  - name: X-Trace\n    value: on\n',
        'headers:\n  - name: X-Trace\n    value: on\n    enabled: false\n    description: off for now\n',
      ),
    );

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    const smoke = soapInterfacesOf(project)
      .flatMap((i) => i.operations.flatMap((o) => o.requests))
      .find((r) => r.name === 'Smoke test');
    expect(smoke?.headers).toEqual([
      { name: 'X-Trace', value: 'on', enabled: false, description: 'off for now' },
      { name: 'X-Trace', value: 'verbose' },
    ]);

    await saveProject(project, dir);
    const saved = await readFile(file, 'utf8');
    expect(saved).toContain('enabled: false');
    expect(saved).toContain('description: off for now');
    // Only the switched-off row says so: a row that is on is written exactly as before.
    expect(saved.match(/enabled:/g)).toHaveLength(1);
  });
});
