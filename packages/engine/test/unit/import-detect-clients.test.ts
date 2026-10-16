import { describe, expect, it } from 'vitest';
import { detectImportFolder, detectImportFormat } from '../../src/import-detect.js';

const kindOf = (text: string): string => detectImportFormat({ text }).kind;

describe('detectImportFormat: other API clients, by content', () => {
  it('detects Insomnia v4 JSON and v5 YAML', () => {
    expect(detectImportFormat({ text: '{ "__export_format": 4, "resources": [] }' })).toEqual({
      kind: 'insomnia',
      label: 'Insomnia export',
      confidence: 'definite',
    });
    expect(kindOf('type: collection.insomnia.rest/5.0\nname: x\n')).toBe('insomnia');
    expect(kindOf('type: spec.insomnia.rest/5.0\nname: x\n')).toBe('insomnia');
    // The type is read from the parsed value, not from the text starting with it
    expect(kindOf('# exported\nschema_version: "5.1"\ntype: collection.insomnia.rest/5.0\n')).toBe('insomnia');
    expect(detectImportFormat({ text: 'type: environment.insomnia.rest/5.0\nname: e\n' })).toEqual({
      kind: 'insomnia-environment',
      label: 'Insomnia environments',
      confidence: 'definite',
    });
  });

  it('detects a Bruno JSON export', () => {
    expect(detectImportFormat({ text: '{ "version": "1", "name": "x", "items": [] }' })).toEqual({
      kind: 'bruno',
      label: 'Bruno collection',
      confidence: 'definite',
    });
    expect(kindOf('{ "version": 1, "name": "x", "items": [] }')).not.toBe('bruno');
  });

  it('detects Hoppscotch collections, array and single-object forms, REST and GraphQL', () => {
    const request = { endpoint: 'https://a', method: 'GET' };
    const collection = { name: 'c', folders: [], requests: [request] };
    expect(detectImportFormat({ text: JSON.stringify([collection]) })).toEqual({
      kind: 'hoppscotch',
      label: 'Hoppscotch collection',
      confidence: 'definite',
    });
    expect(kindOf(JSON.stringify(collection))).toBe('hoppscotch');
    const gql = { name: 'g', folders: [], requests: [{ url: 'https://a', query: '{ a }' }] };
    expect(kindOf(JSON.stringify([gql]))).toBe('hoppscotch');
  });

  it('reads an empty Hoppscotch collection as probable', () => {
    expect(detectImportFormat({ text: '[{ "name": "c", "folders": [], "requests": [] }]' })).toEqual({
      kind: 'hoppscotch',
      label: 'Hoppscotch collection',
      confidence: 'probable',
    });
  });

  it('detects Hoppscotch environments', () => {
    expect(detectImportFormat({ text: '[{ "name": "e", "variables": [{ "key": "a" }] }]' })).toEqual({
      kind: 'hoppscotch-environment',
      label: 'Hoppscotch environments',
      confidence: 'definite',
    });
    expect(kindOf('{ "name": "e", "variables": [{ "key": "a" }] }')).toBe('hoppscotch-environment');
  });

  it('detects Thunder Client collections and environments by the marker', () => {
    expect(
      detectImportFormat({ text: '{ "clientName": "Thunder Client", "collectionName": "c", "requests": [] }' }),
    ).toEqual({ kind: 'thunder-client', label: 'Thunder Client collection', confidence: 'definite' });
    expect(kindOf('{ "client": "Thunder Client", "collectionName": "c", "requests": [] }')).toBe('thunder-client');
    expect(
      detectImportFormat({
        text: '{ "clientName": "Thunder Client", "environmentName": "dev", "variables": [] }',
      }),
    ).toEqual({ kind: 'thunder-client-environment', label: 'Thunder Client environment', confidence: 'definite' });
  });

  it('keeps Thunder Client apart from Hoppscotch, which shares the key names', () => {
    const thunder = {
      clientName: 'Thunder Client',
      collectionName: 'c',
      folders: [],
      requests: [{ url: 'https://a', _id: '1', colId: 'c', method: 'GET' }],
    };
    expect(kindOf(JSON.stringify(thunder))).toBe('thunder-client');
    const hopp = { name: 'c', folders: [], requests: [{ endpoint: 'https://a', method: 'GET' }] };
    expect(kindOf(JSON.stringify(hopp))).toBe('hoppscotch');
  });

  it('leaves the neighbouring formats as they were', () => {
    expect(
      kindOf(
        '{ "info": { "name": "p", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, "item": [] }',
      ),
    ).toBe('postman');
    expect(
      kindOf('{ "name": "e", "values": [{ "key": "a", "value": "1" }], "_postman_variable_scope": "environment" }'),
    ).toBe('postman-environment');
    expect(kindOf('opencollection: 1.0.0\ninfo:\n  name: x\n')).toBe('opencollection');
    expect(kindOf('{ "openapi": "3.0.0", "paths": {} }')).toBe('openapi');
  });
});

describe('detectImportFormat: other API clients, by file name', () => {
  it.each([
    ['Insomnia_2026-01-01.json', 'insomnia', 'Insomnia export'],
    ['x.insomnia.yaml', 'insomnia', 'Insomnia export'],
    ['hoppscotch-team-collections.json', 'hoppscotch', 'Hoppscotch collection'],
    ['hoppscotch-personal-environments.json', 'hoppscotch-environment', 'Hoppscotch environments'],
    ['thunder-collection_api.json', 'thunder-client', 'Thunder Client collection'],
    ['thunder-environment_dev.json', 'thunder-client-environment', 'Thunder Client environment'],
  ])('%s is %s (probable)', (filename, kind, label) => {
    expect(detectImportFormat({ filename })).toEqual({ kind, label, confidence: 'probable' });
  });
});

describe('detectImportFolder', () => {
  it('detects a Bruno folder and prefers OpenCollection when both markers are there', () => {
    expect(detectImportFolder(['bruno.json', 'collection.bru', 'users/'])).toEqual({
      kind: 'bruno',
      label: 'Bruno collection',
      confidence: 'definite',
    });
    expect(detectImportFolder(['bruno.json', 'opencollection.yml']).kind).toBe('opencollection');
  });

  it('detects Thunder Client folders', () => {
    expect(detectImportFolder(['thunderclient.json', 'thunderCollection.json']).kind).toBe('thunder-client');
    expect(detectImportFolder(['collections/', 'environments/', 'thunderActivity.json'])).toEqual({
      kind: 'thunder-client',
      label: 'Thunder Client collection',
      confidence: 'definite',
    });
  });

  it('reads a Postman v3 folder, and anything else as a probable one', () => {
    expect(detectImportFolder(['.resources/', 'a.request.yaml'])).toMatchObject({
      kind: 'postman-v3',
      confidence: 'definite',
    });
    expect(detectImportFolder(['notes.txt'])).toMatchObject({ kind: 'postman-v3', confidence: 'probable' });
    expect(detectImportFolder([])).toMatchObject({ kind: 'postman-v3', confidence: 'probable' });
  });
});
