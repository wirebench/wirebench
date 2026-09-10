import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';
import { parseWsdlBundle } from '../../../src/wsdl/merge.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import { summarizeOperations } from '../../../src/operations.js';
import { exportDefinition } from '../../../src/wsdl/export-definition.js';

const craftedRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/crafted/', import.meta.url));
const publicRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/public/', import.meta.url));

async function resolveFile(root: string, relative: string) {
  const location = pathToFileURL(join(root, relative)).href;
  return resolveDefinition({ location }, { fetchDocument: createDefaultFetchDocument() });
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wirebench-definition-export-'));
}

/** Summarizes a bundle the same way `importDefinition` would, for equality comparisons. */
function summarize(bundle: Awaited<ReturnType<typeof resolveFile>>) {
  const definition = parseWsdlBundle(bundle);
  const schemaSet = buildSchemaSet(bundle);
  const operations = summarizeOperations(definition);
  return {
    operationNames: operations.map((o) => o.operationName).sort(),
    messageNames: definition.messages.map((m) => `${m.name.namespaceUri}#${m.name.localName}`).sort(),
    elementCount: schemaSet.elements.size,
    typeCount: schemaSet.types.size,
  };
}

describe('exportDefinition — nested-imports', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('writes every document with relative references that resolve inside the target dir', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveFile(craftedRoot, 'nested-imports/service.wsdl');

    const result = await exportDefinition(bundle, dir);
    expect(result.files).toHaveLength(4);

    const names = new Set(await readdir(dir));
    for (const f of result.files) {
      expect(names.has(f.file)).toBe(true);
    }

    const rootFile = result.files[0];
    if (rootFile === undefined) throw new Error('expected a root file');
    const rootXml = await readFile(join(dir, rootFile.file), 'utf-8');
    // wsdl:import location must have been rewritten to a bare relative file name that exists on disk.
    const importMatch = /<import[^>]*location="([^"]+)"/.exec(rootXml);
    expect(importMatch).not.toBeNull();
    expect(names.has(importMatch![1]!)).toBe(true);
  });

  it('re-importing the exported root yields an equal definition (operations, messages, schema elements)', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveFile(craftedRoot, 'nested-imports/service.wsdl');
    const original = summarize(bundle);

    const result = await exportDefinition(bundle, dir);
    const rootFile = result.files[0];
    if (rootFile === undefined) throw new Error('expected a root file');

    const reimported = await resolveFile(dir, rootFile.file);
    const reimportedSummary = summarize(reimported);

    expect(reimportedSummary).toEqual(original);
    expect(reimported.problems).toEqual([]);
  });
});

describe('exportDefinition — single-document WSDL (calculator)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('exports one file, well-formed, with an equal operation count after re-import', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveFile(publicRoot, 'calculator/service.wsdl');
    const original = summarize(bundle);

    const result = await exportDefinition(bundle, dir);
    expect(result.files).toHaveLength(1);

    const rootFile = result.files[0];
    if (rootFile === undefined) throw new Error('expected a root file');
    const reimported = await resolveFile(dir, rootFile.file);
    expect(reimported.problems).toEqual([]);
    expect(summarize(reimported).operationNames).toEqual(original.operationNames);
  });
});

describe('exportDefinition — CountryInfo', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('exports and re-imports to an equal definition', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveFile(publicRoot, 'countryinfo/service.wsdl');
    const original = summarize(bundle);

    const result = await exportDefinition(bundle, dir);
    const rootFile = result.files[0];
    if (rootFile === undefined) throw new Error('expected a root file');

    const reimported = await resolveFile(dir, rootFile.file);
    expect(summarize(reimported)).toEqual(original);
  });
});

describe('exportDefinition — never writes a manifest', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('leaves no manifest.yaml in the target directory', async () => {
    const dir = await tempDir();
    dirs.push(dir);
    const bundle = await resolveFile(craftedRoot, 'nested-imports/service.wsdl');
    await exportDefinition(bundle, dir);
    const names = await readdir(dir);
    expect(names).not.toContain('manifest.yaml');
  });
});
