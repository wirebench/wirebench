/**
 * Moving an API to another project (#701): what the confirm lists, what is copied (definition cache,
 * project variables, this machine's secret values), and that a failed save puts both projects back.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, createProject, createRestRequest, createSequence, createSequenceStep } from '@wirebench/engine';
import type { Project, PropertyScopes } from '@wirebench/engine';
import { apiReferences, moveApi, planApiMove } from '../src/api-move.js';
import type { ApiMoveHost, ApiMoveSecrets } from '../src/api-move.js';
import { secretStoreLabel } from '../src/secret-resolver.js';

/** A host over an in-memory model and a real folder; `failSave` makes its next save throw. */
class FakeHost implements ApiMoveHost {
  saves = 0;
  failSave = false;
  constructor(
    public project: Project,
    readonly dir: string,
    readonly extraScopes: Partial<PropertyScopes> = {},
  ) {}
  savedProject(): { readonly project: Project; readonly dir: string } {
    return { project: this.project, dir: this.dir };
  }
  scopesFor(): PropertyScopes {
    return { project: this.project.properties, global: {}, ...this.extraScopes };
  }
  applyModelUpdate(update: (project: Project) => Project): boolean {
    this.project = update(this.project);
    return true;
  }
  save(): Promise<unknown> {
    this.saves += 1;
    if (this.failSave) {
      this.failSave = false;
      return Promise.reject(new Error('disk full'));
    }
    return Promise.resolve();
  }
  expectOnDisk(): void {}
}

interface FakeSecrets extends ApiMoveSecrets {
  readonly entries: Map<string, { value: string; label?: string }>;
}

/** A secret store over a map, labels kept beside values. */
function fakeSecrets(): FakeSecrets {
  const entries = new Map<string, { value: string; label?: string }>();
  let next = 0;
  return {
    entries,
    get: (ref) => Promise.resolve(entries.get(ref)?.value),
    set: (value, opts) => {
      const ref = `sec_${String(next++)}`;
      entries.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return Promise.resolve(ref);
    },
    findByLabel: (label) => Promise.resolve([...entries.entries()].find(([, entry]) => entry.label === label)?.[0]),
    delete: (ref) => Promise.resolve(entries.delete(ref)),
  };
}

function sourceProject(): Project {
  return {
    ...createProject('Source', { id: 'p-src' }),
    properties: { baseHost: 'api.example.com', unrelated: 'x' },
    containers: {
      rest: [
        createApi('Pets', {
          id: 'rest-1',
          slug: 'pets',
          baseUrl: 'https://${baseHost}',
          requests: [
            createRestRequest('List', {
              id: 'r-list',
              url: '/pets?key=${secret:apiKey}&team=${secret:teamKey}&env=${envOnly}',
            }),
          ],
        }),
      ],
    },
    sequences: [createSequence('Smoke', { id: 's-1', steps: [createSequenceStep('r-list', { id: 'st-1' })] })],
  };
}

let root: string;
let source: FakeHost;
let target: FakeHost;
let secrets: FakeSecrets;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'api-move-'));
  await mkdir(join(root, 'src', 'apis', 'pets', 'definition'), { recursive: true });
  await writeFile(join(root, 'src', 'apis', 'pets', 'definition', 'openapi.yaml'), 'openapi: 3.1.0\n');
  await mkdir(join(root, 'tgt'), { recursive: true });
  source = new FakeHost(sourceProject(), join(root, 'src'), { env: { envOnly: '1' } });
  target = new FakeHost(createProject('Target', { id: 'p-tgt' }), join(root, 'tgt'));
  secrets = fakeSecrets();
  await secrets.set('k-123', { label: secretStoreLabel('p-src', 'apiKey') });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('apiReferences', () => {
  it('collects variables, secrets and request ids from the whole container', () => {
    const container = sourceProject().containers['rest']?.[0];
    if (container === undefined) throw new Error('no API');
    const refs = apiReferences(container);
    expect(refs.variables).toEqual(['baseHost', 'envOnly']);
    expect(refs.secrets).toEqual(['apiKey', 'teamKey']);
    expect(refs.requestIds).toEqual(['r-list']);
  });
});

describe('planApiMove', () => {
  it('lists what is copied and what stays behind', async () => {
    const plan = await planApiMove(source, target, 'rest-1', secrets);
    expect(plan).toEqual({
      apiName: 'Pets',
      targetName: 'Target',
      copiedVariables: ['baseHost'],
      copiedSecrets: ['apiKey'],
      unresolvedVariables: ['envOnly'],
      unresolvedSecrets: ['teamKey'],
      keystores: [],
      sequences: ['Smoke'],
    });
  });

  it('copies nothing the target already resolves', async () => {
    target.project = { ...target.project, properties: { baseHost: 'other' } };
    await secrets.set('mine', { label: secretStoreLabel('p-tgt', 'apiKey') });
    const plan = await planApiMove(source, target, 'rest-1', secrets);
    expect(plan.copiedVariables).toEqual([]);
    expect(plan.copiedSecrets).toEqual([]);
  });

  it('refuses a move into the project the API is already in', async () => {
    await expect(planApiMove(source, source, 'rest-1', secrets)).rejects.toThrow(/already in this project/);
  });
});

describe('moveApi', () => {
  it('moves the API with its ids, copies what it needs, and saves both projects', async () => {
    const { sourceBeforeApiId } = await moveApi(source, target, { apiId: 'rest-1' }, secrets);
    expect(sourceBeforeApiId).toBeUndefined();
    expect(source.project.containers['rest']).toBeUndefined();
    const moved = target.project.containers['rest']?.[0];
    expect(moved?.id).toBe('rest-1');
    expect(JSON.stringify(moved)).toContain('r-list');
    expect(target.project.properties).toEqual({ baseHost: 'api.example.com' });
    expect(await readFile(join(root, 'tgt', 'apis', 'pets', 'definition', 'openapi.yaml'), 'utf8')).toBe(
      'openapi: 3.1.0\n',
    );
    const copied = await secrets.findByLabel(secretStoreLabel('p-tgt', 'apiKey'));
    expect(copied === undefined ? undefined : await secrets.get(copied)).toBe('k-123');
    expect([source.saves, target.saves]).toEqual([1, 1]);
  });

  it('puts both projects back and takes back its copies when a save fails', async () => {
    const before = { source: source.project, target: target.project };
    source.failSave = true;
    await expect(moveApi(source, target, { apiId: 'rest-1' }, secrets)).rejects.toThrow('disk full');
    expect(source.project).toBe(before.source);
    expect(target.project).toBe(before.target);
    expect(existsSync(join(root, 'tgt', 'apis', 'pets'))).toBe(false);
    expect(await secrets.findByLabel(secretStoreLabel('p-tgt', 'apiKey'))).toBeUndefined();
    // The source's own folder was never touched by the move.
    expect(existsSync(join(root, 'src', 'apis', 'pets', 'definition', 'openapi.yaml'))).toBe(true);
  });

  it('avoids a stray folder of the same name in the target', async () => {
    await mkdir(join(root, 'tgt', 'apis', 'pets'), { recursive: true });
    await moveApi(source, target, { apiId: 'rest-1' }, secrets);
    const moved = target.project.containers['rest']?.[0];
    expect(moved?.slug).not.toBe('pets');
    expect(existsSync(join(root, 'tgt', 'apis', moved?.slug ?? '', 'definition', 'openapi.yaml'))).toBe(true);
  });
});
