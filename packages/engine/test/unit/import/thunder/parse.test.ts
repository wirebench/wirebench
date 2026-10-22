import { describe, expect, it } from 'vitest';
import { ThunderError } from '#core/errors';
import { readThunderFolder } from '../../../../src/import/thunder/import.js';
import { lines, parseThunderExport, parseThunderFolder } from '../../../../src/import/thunder/parse.js';
import { thunderFixture, thunderFixtureDir } from './fixtures.js';

const exported = (name: string) => parseThunderExport(thunderFixture(name));

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ThunderError ? error.code : 'other';
  }
  return undefined;
}

describe('parseThunderExport', () => {
  it('reads a collection export with either marker key', () => {
    expect(exported('collection-1.2.json').collections.map((c) => c.name)).toEqual(['Shop API']);
    expect(exported('collection-1.0.json').collections.map((c) => c.name)).toEqual(['Legacy']);
  });

  it('reads folders by their parent and requests by their folder', () => {
    const [shop] = exported('collection-1.2.json').collections;
    expect(shop?.folders.map((f) => [f.name, f.parentId])).toEqual([
      ['admin', ''],
      ['orders', 'f-admin'],
      ['lost', 'f-missing'],
    ]);
    expect(shop?.requests.find((r) => r.id === 'r-create')).toMatchObject({
      folderId: 'f-orders',
      method: 'POST',
      params: [
        { name: 'orderId', value: '42', isPath: true, disabled: false },
        { name: 'dryRun', value: 'true', isPath: false, disabled: true },
      ],
      docs: '# Create\nAdds an order.',
      sortNum: 10000,
    });
    expect(shop?.requests.find((r) => r.id === 'r-sse')).toMatchObject({ reqType: 'sse', sortNum: null });
  });

  it('reads an environment export, and a global one with its flags', () => {
    expect(exported('environment-1.0.json').environments[0]).toMatchObject({
      name: 'Staging',
      global: false,
      variables: [
        { name: 'baseUrl', secret: false },
        { name: 'client_id', value: 'env-secret-123', secret: true },
        { name: 'emptySecret', secret: true },
      ],
    });
    expect(exported('environment-1.2-global.json').environments[0]).toMatchObject({
      global: true,
      flags: ['local'],
      variables: [{ name: 'tenant', value: 'acme' }],
    });
  });

  it('reads a workspace collection or environment file picked on its own', () => {
    expect(exported('folder-v3/collections/tc_col_api.json').collections.map((c) => c.name)).toEqual(['Auth']);
    expect(exported('folder-v3/environments/tc_env_dev.json').environments.map((e) => e.name)).toEqual(['Dev']);
  });

  it('refuses text that is not JSON, and JSON that is not an export', () => {
    expect(codeOf(() => parseThunderExport('{'))).toBe('thunder-malformed');
    expect(codeOf(() => parseThunderExport('{"info":{}}'))).toBe('thunder-not-export');
    expect(codeOf(() => parseThunderExport('{"client":"Thunder Client"}'))).toBe('thunder-not-export');
  });

  it('refuses text larger than 50 MB before parsing it', () => {
    expect(codeOf(() => parseThunderExport(' '.repeat(50 * 1024 * 1024 + 1)))).toBe('thunder-too-large');
  });
});

describe('lines', () => {
  it('joins an array of lines and keeps a string', () => {
    expect(lines(['a', 'b'])).toBe('a\nb');
    expect(lines('a')).toBe('a');
    expect(lines(undefined)).toBe('');
  });
});

describe('parseThunderFolder', () => {
  it('reads a v3 folder: its collections and environments, an encrypted value left empty', async () => {
    const files = await readThunderFolder(`${thunderFixtureDir}folder-v3`);
    const { collections, environments } = parseThunderFolder(files);
    expect(collections.map((c) => c.name)).toEqual(['Auth']);
    expect(environments[0]).toMatchObject({
      name: 'Dev',
      envFile: '..\\server\\.env',
      flags: ['default'],
      variables: [
        { name: 'host', value: 'http://localhost:5000', encrypted: false },
        { name: 'color', value: '', secret: true, encrypted: true },
      ],
    });
  });

  it('leaves the _db-backup folder out of the walk', async () => {
    const files = await readThunderFolder(`${thunderFixtureDir}folder-v3`);
    expect([...files.keys()].sort()).toEqual(['collections/tc_col_api.json', 'environments/tc_env_dev.json']);
  });

  it('reads a legacy folder, grouping the requests into their collections by colId', async () => {
    const { collections, environments } = parseThunderFolder(
      await readThunderFolder(`${thunderFixtureDir}folder-legacy`),
    );
    expect(collections.map((c) => [c.name, c.requests.map((r) => r.name)])).toEqual([
      ['Legacy items', ['Get item', 'Health']],
      ['Legacy other', ['Other']],
    ]);
    expect(collections[0]?.folders.map((f) => f.name)).toEqual(['items']);
    expect(environments.map((e) => e.name)).toEqual(['Legacy env']);
  });

  it('refuses a folder that keeps one file per request, naming the export as the way in', () => {
    let message = '';
    try {
      parseThunderFolder(
        new Map([
          ['requests/abc.json', '{}'],
          ['thunder-config.json', '{}'],
        ]),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ThunderError);
      expect((error as ThunderError).code).toBe('thunder-unsupported-layout');
      message = (error as ThunderError).message;
    }
    expect(message).toContain('export the collection');
  });

  it('skips a collection file that is not an object, with a warning', () => {
    const { collections, report } = parseThunderFolder(
      new Map([
        ['collections/tc_col_bad.json', '[]'],
        ['environments/tc_env_a.json', '{"name":"A","data":[]}'],
      ]),
    );
    expect(collections).toEqual([]);
    expect(report.warnings).toEqual([
      'collections/tc_col_bad.json is not a Thunder Client collection, so it was skipped.',
    ]);
  });
});
