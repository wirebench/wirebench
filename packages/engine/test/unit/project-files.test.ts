/**
 * The published JSON Schemas (#66) against what a build writes: real project folders, loaded and
 * saved at the current format, must have every YAML file claimed by exactly one kind and valid
 * against that kind's schema. A JSON Schema validator does the checking, not Zod, so a schema that
 * drops or misstates a constraint in the conversion fails here.
 */
import { cp, readFile } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { PROJECT_FILE_KINDS, PROJECT_SCHEMA_BASE_URL, projectJsonSchemas } from '../../src/project-files.js';
import { loadProject } from '../../src/project/load.js';
import { FORMAT_VERSION } from '../../src/project/model.js';
import { saveProject } from '../../src/project/save.js';
import { parseYaml } from '../../src/project/yaml.js';
import { listTree, sampleProject, tempProjectDir } from './project/fixture.js';

const ENGINE_FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const PROJECTS = {
  'format-v5 fixture': join(ENGINE_FIXTURES, 'format-v5', 'project'),
  'CLI runner fixture': join(import.meta.dirname, '..', '..', '..', 'cli', 'test', 'fixtures', 'runner-project'),
};

function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return new Map(projectJsonSchemas().map(({ kind, schema }) => [kind.name, ajv.compile(schema)]));
}

/** The kinds whose globs claim `relative`. */
function kindsOf(relative: string): string[] {
  return PROJECT_FILE_KINDS.filter((kind) => kind.files.some((glob) => matchesGlob(relative, glob))).map(
    (kind) => kind.name,
  );
}

async function expectValidTree(dir: string): Promise<void> {
  const validate = validators();
  const files = (await listTree(dir)).filter((file) => file.endsWith('.yaml'));
  expect(files).toContain('wirebench.yaml');
  for (const file of files) {
    const kinds = kindsOf(file);
    expect(kinds, file).toHaveLength(1);
    const check = validate.get(kinds[0]!)!;
    const valid = check(parseYaml(await readFile(join(dir, file), 'utf8'), file));
    expect(check.errors ?? [], file).toEqual([]);
    expect(valid, file).toBe(true);
  }
}

describe('projectJsonSchemas', () => {
  it('gives every kind its own schema, under the current format version', () => {
    const schemas = projectJsonSchemas();
    expect(new Set(schemas.map(({ path }) => path)).size).toBe(PROJECT_FILE_KINDS.length);
    for (const { path, kind, schema } of schemas) {
      expect(path).toBe(`v${FORMAT_VERSION}/${kind.name}.schema.json`);
      expect(schema['$id']).toBe(`${PROJECT_SCHEMA_BASE_URL}/${path}`);
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });

  it.each(Object.entries(PROJECTS))(
    'accepts every YAML file of the %s, saved at the current format',
    async (_, source) => {
      const dir = await tempProjectDir();
      await cp(source, dir, { recursive: true });
      const { project, problems } = await loadProject(dir);
      expect(problems).toEqual([]);
      await saveProject(project, dir);
      await expectValidTree(dir);
    },
  );

  it('accepts every YAML file of a sample project as saved', async () => {
    const dir = await tempProjectDir();
    await saveProject(sampleProject(), dir);
    await expectValidTree(dir);
  });

  it('refuses a manifest of another format version, and a request without its kind', () => {
    const validate = validators();
    const manifest = {
      formatVersion: FORMAT_VERSION - 1,
      id: 'p1',
      name: 'P',
      settings: { cacheDefinitions: true, defaultTimeoutMs: 30000, prettyPrintResponses: true },
      properties: {},
    };
    expect(validate.get('manifest')!(manifest)).toBe(false);
    expect(validate.get('manifest')!({ ...manifest, formatVersion: FORMAT_VERSION })).toBe(true);

    const request = { kind: 'rest', id: 'r1', name: 'R', order: 0, method: 'GET', url: 'https://example.test' };
    expect(validate.get('api-request')!(request)).toBe(true);
    const withoutKind: Partial<typeof request> = { ...request };
    delete withoutKind.kind;
    expect(validate.get('api-request')!(withoutKind)).toBe(false);
  });
});
