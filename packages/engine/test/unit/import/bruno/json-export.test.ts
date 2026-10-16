import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrunoError } from '../../../../src/errors.js';
import { ocOfBrunoFolder } from '../../../../src/import/bruno/convert.js';
import { importBruno } from '../../../../src/import/bruno/import.js';
import { isBrunoExport, ocOfBrunoExport } from '../../../../src/import/bruno/json-export.js';
import type { OcItem } from '../../../../src/import/opencollection/model.js';
import { brunoFiles, brunoFixtureDir } from './fixtures.js';

const exportPath = join(brunoFixtureDir, 'export.json');
const exportText = readFileSync(exportPath, 'utf8');
const fromExport = () => ocOfBrunoExport(JSON.parse(exportText));
const fromFolder = () => ocOfBrunoFolder(brunoFiles(), 'basic');

function find(items: readonly OcItem[], name: string): OcItem | undefined {
  for (const item of items) {
    if (item.info.name === name) return item;
    const inner = item.items !== undefined ? find(item.items, name) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/** An item without where it came from or its children, which differ between a folder and an export. */
function content(item: OcItem | undefined): unknown {
  if (item === undefined) return undefined;
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'path' && key !== 'items'));
}

const toJson = (value: unknown): string =>
  JSON.stringify(value, (_k: string, v: unknown): unknown => (v instanceof Map ? Object.fromEntries(v) : v));

describe('ocOfBrunoExport', () => {
  it('converts to the same collection as the folder, for the same content', () => {
    const folder = fromFolder().collection;
    const exported = fromExport().collection;
    expect(exported.info.name).toBe(folder.info.name);
    expect(exported.request).toEqual(folder.request);
    for (const name of ['Users', 'Create user', 'Get user']) {
      expect(content(find(exported.items, name)), name).toEqual(content(find(folder.items, name)));
    }
    expect(exported.environments.find((e) => e.name === 'Local')?.variables).toEqual(
      folder.environments.find((e) => e.name === 'Local')?.variables,
    );
  });

  it('reads an older export whose query is request.query', () => {
    expect(find(fromExport().collection.items, 'Legacy search')?.http).toMatchObject({
      method: 'GET',
      params: [{ name: 'q', value: 'x', type: 'query' }],
    });
  });

  it('reads its camel-case OAuth 2 fields', () => {
    expect(find(fromExport().collection.items, 'Token')?.http?.['auth']).toMatchObject({
      type: 'oauth2',
      accessTokenUrl: 'https://idp.example.com/token',
    });
  });

  it('lists an empty secret as needing a value', async () => {
    const result = await importBruno({ kind: 'text', text: exportText });
    const local = result.variables.environments.find((env) => env.name === 'Local');
    expect(local?.variables.find((v) => v.name === 'clientSecret')).toMatchObject({ secret: true, value: '' });
  });

  it("reports brunoConfig's proxy, and never copies its password or a literal secret", async () => {
    expect(fromExport().collection.configExtras).toEqual(['proxy']);
    const result = await importBruno({ kind: 'text', text: exportText });
    expect(result.report.warnings).toContain("The collection's proxy setting is not supported and was not imported.");
    const all = toJson(result);
    expect(all).not.toContain('proxy-pass-123');
    expect(all).not.toContain('proxyuser');
  });

  it('tells an export from other JSON', () => {
    expect(isBrunoExport(JSON.parse(exportText))).toBe(true);
    expect(isBrunoExport({ info: { name: 'x' }, item: [] })).toBe(false);
  });

  it('refuses JSON that is not an export', () => {
    expect(() => ocOfBrunoExport({ info: { name: 'x' }, item: [] })).toThrow(BrunoError);
    expect(() => ocOfBrunoExport({ info: { name: 'x' }, item: [] })).toThrow(
      expect.objectContaining({ code: 'bruno-not-export' }),
    );
  });

  it('refuses text that is not JSON', async () => {
    await expect(importBruno({ kind: 'text', text: 'meta {' })).rejects.toMatchObject({ code: 'bruno-malformed' });
  });

  it('reads a picked bruno.json as its folder, and any other file as an export', async () => {
    const folder = await importBruno({ kind: 'file', path: join(brunoFixtureDir, 'basic', 'bruno.json') });
    expect(folder.collections[0]?.grpc).toBeDefined();
    const exported = await importBruno({ kind: 'file', path: exportPath });
    expect(exported.collections[0]?.grpc).toBeUndefined();
    expect(exported.counts.requests).toBe(4);
  });

  it("gives the folder's gRPC API its .proto", async () => {
    const result = await importBruno({ kind: 'folder', path: join(brunoFixtureDir, 'basic') });
    const protos = result.collections[0]?.grpcProtos;
    expect(protos?.roots).toEqual(['protos/hello.proto']);
    expect(protos?.sources.get('protos/hello.proto')).toContain('service');
  });
});
