import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { importDefinition } from '../../../src/import.js';
import type { ImportResult } from '../../../src/types.js';
import { createInterface, createProject, createRequest } from '../../../src/project/model.js';
import type { OperationDef, Project, RequestDef } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { generateRequest } from '../../../src/generate.js';
import { applyUpdate, planUpdate } from '../../../src/wsdl/update-definition.js';

const craftedRoot = fileURLToPath(new URL('../../../../../fixtures/wsdl/crafted/', import.meta.url));

const BINDING = '{urn:wb:versioned}VersionedBinding';

async function importVersion(version: 'v1' | 'v2'): Promise<ImportResult> {
  return importDefinition({ kind: 'file', path: join(craftedRoot, 'versioned', version, 'service.wsdl') });
}

let v1: ImportResult;
let v2: ImportResult;

beforeAll(async () => {
  v1 = await importVersion('v1');
  v2 = await importVersion('v2');
});

/** A tiny deterministic id generator, so created requests have stable ids in assertions. */
function counterIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${String(n)}`;
  };
}

/** One operation folder holding one request with the v1 envelope for that operation. */
function operationOf(result: ImportResult, name: string, envelopeXml?: string): OperationDef {
  const generated = generateRequest(result, {
    bindingName: { namespaceUri: 'urn:wb:versioned', localName: 'VersionedBinding' },
    operationName: name,
  });
  const request: RequestDef = createRequest('Request 1', {
    id: `req-${name}`,
    slug: 'request-1',
    envelopeXml: envelopeXml ?? generated.envelopeXml,
    soapVersion: generated.soapVersion,
    ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
  });
  return { name, bindingName: BINDING, slug: name.toLowerCase(), order: 0, requests: [request] };
}

/** A project with one interface built from v1, holding a request per v1 operation. */
function projectFromV1(envelopes: Readonly<Record<string, string>> = {}): Project {
  const base = createProject('Versioned', { id: 'proj-1' });
  const iface = createInterface('VersionedService', {
    id: 'if-1',
    slug: 'versionedservice',
    definitionUrl: 'file:///v1/service.wsdl',
    endpoints: [{ id: 'ep-1', name: 'VersionedPort', url: 'http://example.invalid/versioned', authMode: 'complement' }],
    operations: ['Echo', 'Add', 'Legacy'].map((name, index) => ({
      ...operationOf(v1, name, envelopes[name]),
      order: index,
    })),
  });
  return { ...base, interfaces: [iface] };
}

const DEFAULT_OPTIONS = {
  createNewRequests: true,
  recreateRequests: true,
  recreateOptional: false,
  keepExisting: true,
  keepSoapHeaders: true,
  createBackups: true,
  updateTestRequests: false as const,
};

describe('planUpdate — versioned/v1 → v2', () => {
  it('reports the added, removed and changed operations', () => {
    const plan = planUpdate(v1, v2);
    expect(plan.newOperations.map((ref) => ref.operationName)).toEqual(['Subtract']);
    expect(plan.removedOperations.map((ref) => ref.operationName)).toEqual(['Legacy']);
    expect(plan.changedOperations).toEqual([
      {
        ref: {
          bindingName: { namespaceUri: 'urn:wb:versioned', localName: 'VersionedBinding' },
          operationName: 'Echo',
        },
        reason: 'input-schema',
      },
    ]);
  });

  it('reports the added endpoint and no removed one', () => {
    const plan = planUpdate(v1, v2);
    expect(plan.endpointsAdded).toEqual(['http://example.invalid/versioned-alt']);
    expect(plan.endpointsRemoved).toEqual([]);
  });

  it('is empty for a definition compared with itself', () => {
    const plan = planUpdate(v2, v2);
    expect(plan).toEqual({
      newOperations: [],
      removedOperations: [],
      changedOperations: [],
      endpointsAdded: [],
      endpointsRemoved: [],
    });
  });

  it('reverses into removals and additions when the versions are swapped', () => {
    const plan = planUpdate(v2, v1);
    expect(plan.newOperations.map((ref) => ref.operationName)).toEqual(['Legacy']);
    expect(plan.removedOperations.map((ref) => ref.operationName)).toEqual(['Subtract']);
    expect(plan.endpointsRemoved).toEqual(['http://example.invalid/versioned-alt']);
  });
});

describe('applyUpdate', () => {
  it('creates a request for the new operation when createNewRequests is set', () => {
    const result = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    const iface = result.project.interfaces[0];
    const subtract = iface?.operations.find((op) => op.name === 'Subtract');
    expect(subtract?.requests).toHaveLength(1);
    expect(subtract?.requests[0]?.name).toBe('Request 1');
    expect(subtract?.requests[0]?.envelopeXml).toContain('Subtract');
    expect(result.requestsCreated).toEqual(['id-1']);
  });

  it('creates nothing for the new operation when createNewRequests is clear', () => {
    const result = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      createNewRequests: false,
      newId: counterIds(),
    });
    expect(result.project.interfaces[0]?.operations.map((op) => op.name)).toEqual(['Echo', 'Add', 'Legacy']);
    expect(result.requestsCreated).toEqual([]);
  });

  it('keeps an edited value in a recreated request when keepExisting is set', () => {
    const edited = generateRequest(v1, {
      bindingName: { namespaceUri: 'urn:wb:versioned', localName: 'VersionedBinding' },
      operationName: 'Echo',
    }).envelopeXml.replace('<ver:text>?</ver:text>', '<ver:text>hello</ver:text>');
    expect(edited).toContain('hello');

    const result = applyUpdate(projectFromV1({ Echo: edited }), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    const echo = result.project.interfaces[0]?.operations.find((op) => op.name === 'Echo');
    expect(echo?.requests[0]?.envelopeXml).toContain('hello');
    expect(result.requestsRecreated).toEqual(['req-Echo']);
  });

  it('drops the edited value when keepExisting is clear', () => {
    const edited = generateRequest(v1, {
      bindingName: { namespaceUri: 'urn:wb:versioned', localName: 'VersionedBinding' },
      operationName: 'Echo',
    }).envelopeXml.replace('<ver:text>?</ver:text>', '<ver:text>hello</ver:text>');

    const result = applyUpdate(projectFromV1({ Echo: edited }), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      keepExisting: false,
      newId: counterIds(),
    });
    const echo = result.project.interfaces[0]?.operations.find((op) => op.name === 'Echo');
    expect(echo?.requests[0]?.envelopeXml).not.toContain('hello');
  });

  it('inserts the new optional child only when recreateOptional is set', () => {
    const without = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    const withOptional = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      recreateOptional: true,
      newId: counterIds(),
    });
    const echoOf = (result: typeof without): string =>
      result.project.interfaces[0]?.operations.find((op) => op.name === 'Echo')?.requests[0]?.envelopeXml ?? '';
    expect(echoOf(without)).not.toContain('note');
    expect(echoOf(withOptional)).toContain('note');
  });

  it('leaves envelopes alone when recreateRequests is clear', () => {
    const before = projectFromV1();
    const result = applyUpdate(before, 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      recreateRequests: false,
      newId: counterIds(),
    });
    const echo = result.project.interfaces[0]?.operations.find((op) => op.name === 'Echo');
    expect(echo?.requests[0]?.envelopeXml).toBe(
      before.interfaces[0]?.operations.find((op) => op.name === 'Echo')?.requests[0]?.envelopeXml,
    );
    expect(result.requestsRecreated).toEqual([]);
    expect(result.backups).toEqual([]);
  });

  it('flags the removed operation’s requests orphaned without deleting them', () => {
    const result = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    const legacy = result.project.interfaces[0]?.operations.find((op) => op.name === 'Legacy');
    expect(legacy?.requests).toHaveLength(1);
    expect(legacy?.requests[0]?.orphaned).toBe(true);
    expect(result.requestsOrphaned).toEqual(['req-Legacy']);
  });

  it('clears the orphan flag when a later definition brings the operation back', () => {
    const orphaned = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    }).project;
    const restored = applyUpdate(orphaned, 'if-1', planUpdate(v2, v1), v1, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    const legacy = restored.project.interfaces[0]?.operations.find((op) => op.name === 'Legacy');
    expect(legacy?.requests[0]?.orphaned).toBeUndefined();
    expect(restored.requestsOrphaned).toEqual(['id-1']);
  });

  it('adds the new endpoint and rebases the definition URL', () => {
    const result = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    const iface = result.project.interfaces[0];
    expect(iface?.endpoints.map((endpoint) => endpoint.url)).toEqual([
      'http://example.invalid/versioned',
      'http://example.invalid/versioned-alt',
    ]);
    expect(iface?.definitionUrl).toContain('/versioned/v2/service.wsdl');
  });

  it('names the backup of every recreated envelope, and none when createBackups is clear', () => {
    const withBackups = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    expect(withBackups.backups).toEqual(['interfaces/versionedservice/operations/echo/request-1.xml.bak']);

    const without = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      createBackups: false,
      newId: counterIds(),
    });
    expect(without.backups).toEqual([]);
  });

  it('throws for an interface the project does not have', () => {
    expect(() => applyUpdate(projectFromV1(), 'nope', planUpdate(v1, v2), v2, DEFAULT_OPTIONS)).toThrow(/nope/);
  });
});

describe('saveProject backups', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes the previous envelope to <request>.xml.bak before overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-update-save-'));
    dirs.push(dir);
    const before = projectFromV1();
    await saveProject(before, dir);

    const backupRelative = 'interfaces/versionedservice/operations/echo/request-1.xml.bak';
    const envelopeRelative = 'interfaces/versionedservice/operations/echo/request-1.xml';
    const original = await readFile(join(dir, ...envelopeRelative.split('/')), 'utf8');

    const updated = applyUpdate(before, 'if-1', planUpdate(v1, v2), v2, { ...DEFAULT_OPTIONS, newId: counterIds() });
    await saveProject(updated.project, dir, { backups: updated.backups });

    expect(await readFile(join(dir, ...backupRelative.split('/')), 'utf8')).toBe(original);
    expect(await readFile(join(dir, ...envelopeRelative.split('/')), 'utf8')).not.toBe(original);
  });

  it('skips a backup whose envelope file does not exist, and any non-.bak path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-update-save-'));
    dirs.push(dir);
    const project = projectFromV1();
    await saveProject(project, dir);
    await saveProject(project, dir, { backups: ['interfaces/nope/x.xml.bak', 'not-a-backup'] });
    await expect(readFile(join(dir, 'interfaces/nope/x.xml.bak'))).rejects.toThrow();
    await expect(readFile(join(dir, 'not-a-backup'))).rejects.toThrow();
  });

  it('round-trips the orphan flag through save and load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-update-save-'));
    dirs.push(dir);
    const updated = applyUpdate(projectFromV1(), 'if-1', planUpdate(v1, v2), v2, {
      ...DEFAULT_OPTIONS,
      newId: counterIds(),
    });
    await saveProject(updated.project, dir);
    const yaml = await readFile(
      join(dir, 'interfaces/versionedservice/operations/legacy/request-1.request.yaml'),
      'utf8',
    );
    expect(yaml).toContain('orphaned: true');
    const { loadProject } = await import('../../../src/project/load.js');
    const loaded = await loadProject(dir);
    const legacy = loaded.project.interfaces[0]?.operations.find((op) => op.name === 'Legacy');
    expect(legacy?.requests[0]?.orphaned).toBe(true);
    await writeFile(join(dir, 'README.txt'), 'foreign file');
  });
});
