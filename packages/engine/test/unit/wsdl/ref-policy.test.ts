/**
 * The import-reference policy (`wsdl/ref-policy.ts`), exercised adversarially through
 * `resolveDefinition` with the *real* file fetcher wired in: every "refused" assertion also
 * asserts that `node:fs/promises`' `readFile` was never called for the refused path, so a
 * policy that reported a problem *after* reading the file would still fail here.
 */

import { mkdtemp, readFile as realReadFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMPORT_DEPTH, MAX_IMPORT_DOCUMENTS, classifyLocation } from '../../../src/wsdl/ref-policy.js';
import { createDefaultFetchDocument } from '../../../src/wsdl/fetch.js';
import type { FetchDocument, FetchedDocument } from '../../../src/wsdl/resolver.js';
import { resolveDefinition } from '../../../src/wsdl/resolver.js';

const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn<(path: unknown) => void>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    readFile: (path: unknown, ...rest: unknown[]) => {
      readFileSpy(path);
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const WSDL_NS = 'http://schemas.xmlsoap.org/wsdl/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

/** A minimal WSDL whose `types` section imports each of `schemaLocations`. */
function wsdlImporting(...schemaLocations: readonly string[]): string {
  const imports = schemaLocations
    .map((location) => `<xs:import namespace="urn:x" schemaLocation="${location}"/>`)
    .join('');
  return `<definitions xmlns="${WSDL_NS}" targetNamespace="urn:t"><types><xs:schema xmlns:xs="${XSD_NS}">${imports}</xs:schema></types></definitions>`;
}

/** A minimal XSD that optionally imports one further schema. */
function xsd(namespace: string, schemaLocation?: string): string {
  const inner = schemaLocation === undefined ? '' : `<xs:import namespace="urn:x" schemaLocation="${schemaLocation}"/>`;
  return `<xs:schema xmlns:xs="${XSD_NS}" targetNamespace="${namespace}">${inner}</xs:schema>`;
}

/**
 * Serves `docs` for every non-`file:` location and delegates `file:` to the real default
 * fetcher — so a policy hole really does read the disk, and the spy really does see it.
 */
function makeFetcher(docs: Record<string, string>): FetchDocument {
  const real = createDefaultFetchDocument();
  return (location: string, signal?: AbortSignal): Promise<FetchedDocument> => {
    if (location.startsWith('file:')) {
      return real(location, signal);
    }
    const text = docs[location];
    if (text === undefined) {
      return Promise.reject(new Error(`no fixture for "${location}"`));
    }
    return Promise.resolve({ location, bytes: new TextEncoder().encode(text), text });
  };
}

beforeEach(() => {
  readFileSpy.mockClear();
});

describe('classifyLocation', () => {
  it('folds https into http and keeps every other scheme as itself', () => {
    expect(classifyLocation('https://a.test/x.wsdl')).toBe('http');
    expect(classifyLocation('http://a.test/x.wsdl')).toBe('http');
    expect(classifyLocation('file:///tmp/x.wsdl')).toBe('file');
    expect(classifyLocation('inline:wsdl')).toBe('inline');
    expect(classifyLocation('./relative.xsd')).toBe('relative');
  });
});

describe('resolveDefinition — a remote root may not reach the local disk', () => {
  it('refuses a nested file: reference without reading the file', async () => {
    const root = 'https://evil.test/service.wsdl';
    const bundle = await resolveDefinition(
      { location: root },
      { fetchDocument: makeFetcher({ [root]: wsdlImporting('file:///etc/hosts') }) },
    );

    expect(bundle.documents).toHaveLength(1);
    const refused = bundle.problems.filter((problem) => problem.code === 'import-ref-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.message).toContain('file:///etc/hosts');
    expect(refused[0]?.message).toContain('may not reference local files');
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('still follows http(s) references from a remote root', async () => {
    const root = 'https://a.test/service.wsdl';
    const nested = 'http://b.test/common.xsd';
    const bundle = await resolveDefinition(
      { location: root },
      { fetchDocument: makeFetcher({ [root]: wsdlImporting(nested), [nested]: xsd('urn:x') }) },
    );

    expect(bundle.documents.map((document) => document.location)).toEqual([root, nested]);
    expect(bundle.problems).toEqual([]);
  });
});

describe('resolveDefinition — a file root stays inside its own folder', () => {
  let dir: string;
  let outside: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wirebench-refpolicy-'));
    outside = join(dir, 'outside.xsd');
    await writeFile(outside, xsd('urn:x'), 'utf-8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a reference beside the root document', async () => {
    const projectDir = join(dir, 'project');
    const schemasDir = join(projectDir, 'schemas');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(schemasDir, { recursive: true });
    const rootPath = join(projectDir, 'service.wsdl');
    await writeFile(rootPath, wsdlImporting('schemas/common.xsd'), 'utf-8');
    await writeFile(join(schemasDir, 'common.xsd'), xsd('urn:x'), 'utf-8');

    const bundle = await resolveDefinition(
      { location: pathToFileURL(rootPath).href },
      { fetchDocument: makeFetcher({}) },
    );

    expect(bundle.problems).toEqual([]);
    expect(bundle.documents).toHaveLength(2);
    expect(bundle.documents[1]?.location).toBe(pathToFileURL(join(schemasDir, 'common.xsd')).href);
  });

  it('refuses a ../ reference out of the folder without reading the file', async () => {
    const projectDir = join(dir, 'project2');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir, { recursive: true });
    const rootPath = join(projectDir, 'service.wsdl');
    await writeFile(rootPath, wsdlImporting('../outside.xsd'), 'utf-8');

    const bundle = await resolveDefinition(
      { location: pathToFileURL(rootPath).href },
      { fetchDocument: makeFetcher({}) },
    );

    expect(bundle.documents).toHaveLength(1);
    expect(bundle.problems.map((problem) => problem.code)).toEqual(['import-ref-refused']);
    expect(bundle.problems[0]?.message).toContain("outside the definition's folder");
    // The root itself is read; the refused reference must never be.
    expect(
      readFileSpy.mock.calls
        .flat()
        .map(String)
        .some((path) => path.includes('outside.xsd')),
    ).toBe(false);
    // …and its content is genuinely readable, so the refusal is the policy, not a missing file.
    await expect(realReadFile(outside, 'utf-8')).resolves.toContain('schema');
  });

  it('refuses a symlink that points out of the folder', async () => {
    const projectDir = join(dir, 'project3');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir, { recursive: true });
    const rootPath = join(projectDir, 'service.wsdl');
    await writeFile(rootPath, wsdlImporting('escape.xsd'), 'utf-8');
    await symlink(outside, join(projectDir, 'escape.xsd'));

    const bundle = await resolveDefinition(
      { location: pathToFileURL(rootPath).href },
      { fetchDocument: makeFetcher({}) },
    );

    expect(bundle.documents).toHaveLength(1);
    expect(bundle.problems.map((problem) => problem.code)).toEqual(['import-ref-refused']);
    expect(
      readFileSpy.mock.calls
        .flat()
        .map(String)
        .some((path) => path.includes('escape.xsd')),
    ).toBe(false);
  });

  it('refuses an http(s) reference from a file root', async () => {
    const projectDir = join(dir, 'project4');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectDir, { recursive: true });
    const rootPath = join(projectDir, 'service.wsdl');
    await writeFile(rootPath, wsdlImporting('https://a.test/common.xsd'), 'utf-8');

    const bundle = await resolveDefinition(
      { location: pathToFileURL(rootPath).href },
      { fetchDocument: makeFetcher({ 'https://a.test/common.xsd': xsd('urn:x') }) },
    );

    expect(bundle.documents).toHaveLength(1);
    expect(bundle.problems[0]?.code).toBe('import-ref-refused');
    expect(bundle.problems[0]?.message).toContain('may only reference files beside it');
  });
});

describe('resolveDefinition — a pasted or dropped root', () => {
  it('cannot reach the disk and says how to import a WSDL with neighbours', async () => {
    const root = 'dropped:service.wsdl';
    const bundle = await resolveDefinition(
      { location: root, text: wsdlImporting('file:///etc/hosts', 'schemas/common.xsd') },
      { fetchDocument: makeFetcher({}) },
    );

    const codes = bundle.problems.map((problem) => problem.code).sort();
    expect(codes).toEqual(['import-ref-refused', 'unresolved-import']);
    expect(bundle.problems.find((problem) => problem.code === 'unresolved-import')?.message).toContain(
      'Use Browse… to import a WSDL whose imports live next to it',
    );
    expect(readFileSpy).not.toHaveBeenCalled();
  });
});

describe('resolveDefinition — runaway graphs are capped', () => {
  it('stops at the depth cap and reports import-limit', async () => {
    const docs: Record<string, string> = {};
    const location = (index: number): string => `mem://chain/${String(index)}.xsd`;
    const root = 'mem://chain/root.wsdl';
    docs[root] = wsdlImporting(location(0));
    for (let index = 0; index <= MAX_IMPORT_DEPTH + 5; index += 1) {
      docs[location(index)] = xsd(`urn:x${String(index)}`, location(index + 1));
    }

    const bundle = await resolveDefinition({ location: root }, { fetchDocument: makeFetcher(docs) });

    expect(bundle.documents.length).toBe(MAX_IMPORT_DEPTH + 1);
    expect(bundle.problems.map((problem) => problem.code)).toEqual(['import-limit']);
    expect(bundle.problems[0]?.message).toContain('deeper than');
  });

  it('stops at the document cap and reports import-limit', async () => {
    const docs: Record<string, string> = {};
    const root = 'mem://wide/root.wsdl';
    const locations: string[] = [];
    for (let index = 0; index < MAX_IMPORT_DOCUMENTS + 20; index += 1) {
      const location = `mem://wide/${String(index)}.xsd`;
      locations.push(location);
      docs[location] = xsd(`urn:x${String(index)}`);
    }
    docs[root] = wsdlImporting(...locations);

    const bundle = await resolveDefinition({ location: root }, { fetchDocument: makeFetcher(docs) });

    expect(bundle.documents.length).toBe(MAX_IMPORT_DOCUMENTS);
    expect(bundle.problems.map((problem) => problem.code)).toEqual(['import-limit']);
    expect(bundle.problems[0]?.message).toContain('larger than');
  });
});
