import { describe, expect, it } from 'vitest';
import { detectImportFolder, detectImportFormat } from '../../src/import-detect.js';

const kindOf = (text: string, filename?: string) => detectImportFormat({ text, filename });
const json = (value: unknown): string => JSON.stringify(value);

describe('detectImportFormat: other clients by content', () => {
  it('reads an Insomnia v4 export and every v5 kind', () => {
    expect(kindOf(json({ _type: 'export', __export_format: 4, resources: [] }))).toMatchObject({
      kind: 'insomnia',
      confidence: 'definite',
    });
    expect(kindOf(json({ __export_format: 3, resources: [] })).kind).toBe('insomnia');
    expect(kindOf('type: collection.insomnia.rest/5.0\nname: A\ncollection: []\n')).toMatchObject({
      kind: 'insomnia',
      confidence: 'definite',
    });
    expect(kindOf('schema_version: "5.1"\ntype: spec.insomnia.rest/5.0\nname: A\n').kind).toBe('insomnia');
    expect(kindOf('type: environment.insomnia.rest/5.0\nname: E\n').kind).toBe('insomnia-environment');
    // A mock server or MCP file is still Insomnia: the importer refuses it by name.
    expect(kindOf('type: mock.insomnia.rest/5.0\nname: M\n').kind).toBe('insomnia');
    expect(kindOf('type: mcpClient.insomnia/5.0\nname: M\n').kind).toBe('insomnia');
  });

  it('reads a Bruno JSON export', () => {
    expect(kindOf(json({ version: '1', name: 'x', items: [] }))).toMatchObject({
      kind: 'bruno',
      confidence: 'definite',
    });
  });

  it('reads Hoppscotch collections, single or in an array, and environments', () => {
    const collection = { name: 'c', folders: [], requests: [{ endpoint: 'https://a', method: 'GET' }] };
    expect(kindOf(json([collection]))).toMatchObject({ kind: 'hoppscotch', confidence: 'definite' });
    expect(kindOf(json(collection)).kind).toBe('hoppscotch');
    const graphql = { name: 'g', folders: [], requests: [{ url: 'https://a', query: '{ a }' }] };
    expect(kindOf(json([graphql])).kind).toBe('hoppscotch');
    const nested = { name: 'n', folders: [collection], requests: [] };
    expect(kindOf(json(nested))).toMatchObject({ kind: 'hoppscotch', confidence: 'definite' });
    expect(kindOf(json([{ name: 'e', variables: [{ key: 'a', value: '1' }] }]))).toMatchObject({
      kind: 'hoppscotch-environment',
      confidence: 'definite',
    });
  });

  it('calls an empty Hoppscotch collection probable', () => {
    expect(kindOf(json({ name: 'c', folders: [], requests: [] }))).toMatchObject({
      kind: 'hoppscotch',
      confidence: 'probable',
    });
  });

  it('reads Thunder Client exports by either marker', () => {
    expect(kindOf(json({ clientName: 'Thunder Client', collectionName: 'c', requests: [] }))).toMatchObject({
      kind: 'thunder-client',
      confidence: 'definite',
    });
    expect(kindOf(json({ client: 'Thunder Client', collectionName: 'c', requests: [] })).kind).toBe('thunder-client');
    expect(kindOf(json({ clientName: 'Thunder Client', environmentName: 'dev', variables: [] })).kind).toBe(
      'thunder-client-environment',
    );
  });

  it('never takes a Thunder Client file for Hoppscotch, or the reverse', () => {
    const thunder = {
      clientName: 'Thunder Client',
      collectionName: 'c',
      folders: [],
      requests: [{ _id: 'r', colId: 'c', containerId: '', name: 'r', url: 'https://a', method: 'GET' }],
    };
    expect(kindOf(json(thunder)).kind).toBe('thunder-client');
    const hoppscotch = { v: 12, name: 'c', folders: [], requests: [{ v: '17', endpoint: 'https://a', method: 'GET' }] };
    expect(kindOf(json(hoppscotch)).kind).toBe('hoppscotch');
  });

  it('leaves the neighbours as they were', () => {
    expect(
      kindOf(
        json({
          info: { name: 'p', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
          item: [],
        }),
      ).kind,
    ).toBe('postman');
    expect(kindOf(json({ name: 'e', values: [], _postman_variable_scope: 'environment' })).kind).toBe(
      'postman-environment',
    );
    expect(kindOf('opencollection: 1.0.0\ninfo:\n  name: x\nitems: []\n').kind).toBe('opencollection');
    expect(kindOf('openapi: 3.1.0\ninfo: {title: x, version: "1"}\npaths: {}\n').kind).toBe('openapi');
  });
});

describe('detectImportFormat: other clients by name', () => {
  it('names the format of a file whose content says nothing', () => {
    expect(detectImportFormat({ filename: 'Insomnia_2026-01-01.json' })).toMatchObject({
      kind: 'insomnia',
      confidence: 'probable',
    });
    expect(detectImportFormat({ filename: '/x/y/api.insomnia.yaml' }).kind).toBe('insomnia');
    expect(detectImportFormat({ filename: 'hoppscotch-team-collections.json' }).kind).toBe('hoppscotch');
    expect(detectImportFormat({ filename: 'hoppscotch-personal-environments.json' }).kind).toBe(
      'hoppscotch-environment',
    );
    expect(detectImportFormat({ filename: 'thunder-collection_api.json' }).kind).toBe('thunder-client');
    expect(detectImportFormat({ filename: 'thunder-environment_dev.json' }).kind).toBe('thunder-client-environment');
    expect(detectImportFormat({ filename: '/c/bruno.json' }).kind).toBe('bruno');
  });
});

describe('detectImportFolder', () => {
  it('reads a Bruno folder, unless an opencollection.yml is beside it', () => {
    expect(detectImportFolder(['bruno.json', 'collection.bru', 'users/']).kind).toBe('bruno');
    expect(detectImportFolder(['bruno.json', 'opencollection.yml']).kind).toBe('opencollection');
  });

  it("reads Thunder Client's own files", () => {
    expect(detectImportFolder(['thunderclient.json', 'thunderCollection.json']).kind).toBe('thunder-client');
    expect(detectImportFolder(['collections/', 'environments/', 'thunderActivity.json']).kind).toBe('thunder-client');
  });

  it('falls back to a folder collection', () => {
    expect(detectImportFolder(['.resources/', 'a.request.yaml'])).toMatchObject({
      kind: 'postman-v3',
      confidence: 'definite',
    });
    expect(detectImportFolder(['collections/', 'environments/'])).toMatchObject({
      kind: 'postman-v3',
      confidence: 'probable',
    });
  });
});
