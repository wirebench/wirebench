// @vitest-environment node
/** An API's GraphQL schema in the open project: stored, read back, cleared (#77). */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineService } from '../src/engine-service.js';
import { ProjectHost } from '../src/project-host.js';
import { testHooks } from './helpers/project-hooks.js';

const SDL = 'type Query {\n  ping: String\n}\n';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function opened(): Promise<{ host: ProjectHost; dir: string; apiId: string }> {
  root = mkdtempSync(join(tmpdir(), 'wirebench-graphql-'));
  const dir = join(root, 'Shop');
  const host = new ProjectHost(new EngineService(), testHooks());
  await host.create({ dir, name: 'Shop' });
  const added = await host.mutate({ kind: 'add-api', name: 'Shop', baseUrl: 'https://shop.test' });
  await host.save({ reason: 'add-api' });
  return { host, dir, apiId: added.createdId ?? '' };
}

describe('the GraphQL schema of an API', () => {
  it('is written beside the API, recorded in it, and read back after a reopen', async () => {
    const { host, dir, apiId } = await opened();
    const ref = await host.kind('rest').setGraphqlSchema(apiId, SDL, 'https://shop.test/graphql');

    expect(ref.source).toBe('https://shop.test/graphql');
    expect(await readFile(join(dir, 'apis', 'Shop', 'graphql', 'schema.graphql'), 'utf8')).toBe(SDL);
    expect(await readFile(join(dir, 'apis', 'Shop', 'api.yaml'), 'utf8')).toContain('graphqlSchema:');
    expect((await host.kind('rest').graphqlSchemaFor(apiId))?.getQueryType()?.name).toBe('Query');
    await host.close();

    const reopened = new ProjectHost(new EngineService(), testHooks());
    const project = await reopened.openProject(dir);
    expect(project.apis.find((api) => api.id === apiId)?.graphqlSchema).toEqual(ref);
    expect((await reopened.kind('rest').graphqlSchemaFor(apiId))?.getType('Query')).toBeDefined();
    await reopened.close();
  });

  it('answers none for an API without one', async () => {
    const { host, apiId } = await opened();
    expect(await host.kind('rest').graphqlSchemaFor(apiId)).toBeUndefined();
    await host.close();
  });

  it('is cleared: the file and the record go, and the cached schema with them', async () => {
    const { host, dir, apiId } = await opened();
    await host.kind('rest').setGraphqlSchema(apiId, SDL, 'schema.graphql');
    await host.kind('rest').graphqlSchemaFor(apiId);
    await host.kind('rest').clearGraphqlSchema(apiId);

    expect(existsSync(join(dir, 'apis', 'Shop', 'graphql', 'schema.graphql'))).toBe(false);
    expect(await readFile(join(dir, 'apis', 'Shop', 'api.yaml'), 'utf8')).not.toContain('graphqlSchema');
    expect(await host.kind('rest').graphqlSchemaFor(apiId)).toBeUndefined();
    await host.close();
  });
});
