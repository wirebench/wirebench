// apps/desktop/test/import-variables-apply.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ImportedVariables } from '@wirebench/engine';
import { applyImportedVariables, type VariablesApplyPorts } from '../src/main/import-variables-apply.js';

function fakePorts(options: { envNames?: string[]; globals?: Record<string, string>; failSave?: boolean } = {}) {
  const added: { name: string; properties: Record<string, string>; disabled: readonly string[] }[] = [];
  const store = new Map<string, { value: string; label: string }>();
  const globals = { properties: { ...(options.globals ?? {}) } as Record<string, string>, disabled: [] as string[] };
  let counter = 0;
  const ports: VariablesApplyPorts = {
    workspace: {
      environmentNames: () => [...(options.envNames ?? []), ...added.map((a) => a.name)],
      addEnvironment: (name, properties, disabled) => {
        if (options.failSave === true) return Promise.reject(new Error('disk full'));
        added.push({ name, properties, disabled });
        return Promise.resolve();
      },
      propertyNames: () => [],
      mergeProperties: () => Promise.resolve(),
    },
    globals: {
      get: () => globals,
      merge: (properties, disabled) => {
        Object.assign(globals.properties, properties);
        globals.disabled.push(...disabled);
        return Promise.resolve();
      },
    },
    secrets: {
      set: (value, { label }) => {
        counter += 1;
        const ref = `sec_${counter}`;
        store.set(ref, { value, label });
        return Promise.resolve(ref);
      },
      delete: (ref) => Promise.resolve(store.delete(ref)),
    },
  };
  return { ports, added, store, globals };
}

const plan = (over: Partial<ImportedVariables>): ImportedVariables => ({
  environments: [],
  report: { warnings: [], notes: [] },
  ...over,
});

describe('applyImportedVariables', () => {
  it('adds an environment under a free name and stores secrets by reference', async () => {
    const { ports, added, store } = fakePorts({ envNames: ['staging'] });
    const result = await applyImportedVariables(
      plan({
        environments: [
          {
            name: 'Staging',
            variables: [
              { name: 'host', value: 'h', enabled: true, secret: false },
              { name: 'old', value: 'o', enabled: false, secret: false },
              { name: 'token', value: '', enabled: true, secret: true, secretValue: 't0k' },
              { name: 'empty', value: '', enabled: true, secret: true },
            ],
          },
        ],
      }),
      ports,
    );

    expect(added).toEqual([
      {
        name: 'Staging 2',
        properties: { host: 'h', old: 'o', token: '${secret:sec_1}', empty: '' },
        disabled: ['old'],
      },
    ]);
    expect(store.get('sec_1')).toEqual({ value: 't0k', label: 'Staging 2/token' });
    expect(result.environments).toEqual([{ name: 'Staging 2', renamedFrom: 'Staging', variables: 4 }]);
    expect(result.secretsStored).toBe(1);
    expect(result.notes).toContain(
      'An environment named "Staging" already exists, so this one was imported as "Staging 2".',
    );
    expect(result.warnings).toContain(
      'Staging 2: the secret "empty" had no value in the file; set it in Environments.',
    );
  });

  it('keeps existing globals and reports the names it skipped', async () => {
    const { ports, globals } = fakePorts({ globals: { tenant: 'mine' } });
    const result = await applyImportedVariables(
      plan({
        globals: {
          name: 'Globals',
          variables: [
            { name: 'tenant', value: 'theirs', enabled: true, secret: false },
            { name: 'region', value: 'eu', enabled: false, secret: false },
          ],
        },
      }),
      ports,
    );
    expect(globals.properties).toEqual({ tenant: 'mine', region: 'eu' });
    expect(globals.disabled).toEqual(['region']);
    expect(result.globals).toEqual({ added: 1, skipped: ['tenant'] });
    expect(result.notes).toContain('Globals: "tenant" already exists and kept its current value.');
  });

  it('deletes the secrets it wrote when a save fails', async () => {
    const { ports, store } = fakePorts({ failSave: true });
    await expect(
      applyImportedVariables(
        plan({
          environments: [
            { name: 'E', variables: [{ name: 'token', value: '', enabled: true, secret: true, secretValue: 'x' }] },
          ],
        }),
        ports,
      ),
    ).rejects.toThrow('disk full');
    expect(store.size).toBe(0);
  });
});
