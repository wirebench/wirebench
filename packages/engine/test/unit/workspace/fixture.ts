import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_FORMAT_VERSION } from '../../../src/workspace/model.js';
import type { Workspace } from '../../../src/workspace/model.js';

/** Deterministic ids so the fixture workspace is byte-stable across runs. */
export function fixedIds(prefix = 'ID'): () => string {
  let n = 0;
  return () => `${prefix}${(n += 1).toString().padStart(4, '0')}`;
}

/** Creates an empty temporary directory for a workspace. */
export async function tempWorkspaceDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'wirebench-workspace-'));
}

/** Every file below `dir`, as sorted `/`-separated relative paths. */
export async function listTree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await listTree(join(dir, entry.name), relative)));
    } else {
      out.push(relative);
    }
  }
  return out.sort();
}

/** Reads a workspace file as raw bytes. */
export async function readBytes(root: string, relative: string): Promise<Buffer> {
  return readFile(join(root, ...relative.split('/')));
}

/**
 * A workspace exercising the interesting corners: an internal and a linked
 * project reference, two environments (one with endpoints and properties, one
 * empty), an active environment, and top-level properties.
 */
export function sampleWorkspace(): Workspace {
  const nextId = fixedIds();
  const countryProjectId = nextId();
  const ordersProjectId = nextId();
  const devEnvId = nextId();
  const prodEnvId = nextId();

  return {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id: nextId(),
    name: 'Demo Workspace',
    description: 'Round-trip fixture',
    createdAt: '2026-01-01T00:00:00.000Z',
    properties: { region: 'eu-west-1', tier: 'gold' },
    disabledProperties: ['tier'],
    activeEnvironmentId: devEnvId,
    projects: [
      { id: countryProjectId, slug: 'CountryInfo', source: 'internal' },
      { id: ordersProjectId, slug: 'Orders', source: 'linked', path: '/srv/wirebench-projects/orders' },
    ],
    environments: [
      {
        id: devEnvId,
        name: 'dev',
        slug: 'dev',
        order: 0,
        properties: { region: 'local' },
        endpoints: { 'CountryInfo/CountryInfoSoap': 'http://localhost:8080/country' },
        disabledProperties: ['region'],
      },
      {
        id: prodEnvId,
        name: 'prod',
        slug: 'prod',
        order: 1,
        properties: {},
        endpoints: {},
        disabledProperties: [],
      },
    ],
  };
}
