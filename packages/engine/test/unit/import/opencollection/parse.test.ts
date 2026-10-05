import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpenCollectionError } from '../../../../src/errors.js';
import type { OcItem } from '../../../../src/import/opencollection/index.js';
import { isOpenCollection, parseOpenCollection } from '../../../../src/import/opencollection/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '../../../../../../fixtures');

function readFixture(rel: string): string {
  return readFileSync(resolve(fixtureDir, rel), 'utf8');
}

/** Every `.yml` / `.yaml` file under a fixture folder, keyed by its POSIX path relative to it. */
function readTree(rel: string): Map<string, string> {
  const root = resolve(fixtureDir, rel);
  const files = new Map<string, string>();
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!/\.ya?ml$/.test(entry)) continue;
    files.set(entry.split('\\').join('/'), readFileSync(resolve(root, entry), 'utf8'));
  }
  return files;
}

function find(items: readonly OcItem[] | undefined, pick: (item: OcItem) => boolean): OcItem | undefined {
  for (const item of items ?? []) {
    if (pick(item)) return item;
    const inner = find(item.items, pick);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

describe('parseOpenCollection', () => {
  it('reads a single document: items, environments', () => {
    const c = parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml'));
    expect(c.version).toBe('1.0.0');
    expect(c.info.name).toBe('Pets');
    expect(c.items.map((i) => i.info.name)).toEqual(['Users', 'Graph', 'Pets gRPC', 'Socket', 'Dashboard']);
    expect(c.items[0]?.items?.map((i) => i.info.name)).toEqual(['Create User', 'Get User']);
    expect(c.items[0]?.items?.[0]?.path).toBe('items[0].items[1]');
    expect(c.environments.map((e) => e.name)).toEqual(['dev']);
    expect(c.environments[0]?.variables.map((v) => v.name)).toEqual(['baseUrl', 'token', 'region']);
    expect(c.environments[0]?.variables[1]?.secret).toBe(true);
    expect(c.request?.variables?.[0]?.name).toBe('tenant');
    const get = c.items[0]?.items?.[1];
    expect(get?.runtime?.assertions).toEqual([
      { expression: 'res.status', operator: 'eq', value: '200' },
      { expression: 'res.body.name', operator: 'isNotNull' },
    ]);
    expect(get?.runtime?.scripts?.[0]?.type).toBe('tests');
  });

  it('reads the directory form from a path → text map, folders from subfolders', () => {
    const files = readTree('opencollection/crafted/tree');
    const c = parseOpenCollection(files.get('opencollection.yml')!, files);
    const users = c.items.find((i) => i.info.name === 'Users')!;
    expect(users.items?.map((i) => i.info.name)).toEqual(['Create User', 'Get User']);
    expect(users.request?.headers?.[0]?.name).toBe('X-Team');
    expect(users.path).toBe('Users');
    expect(users.items?.[0]?.path).toBe('Users/create-user.yml');
    expect(c.environments.map((e) => e.name)).toEqual(['dev']);
    expect(find(c.items, (i) => i.script !== undefined)?.info.name).toBe('helpers');
    expect(c.items.some((i) => i.script !== undefined)).toBe(false);
    expect(c.items.map((i) => i.info.name)).toEqual(['Users', 'Graph', 'Pets gRPC', 'shared', 'Socket']);
    expect(c.configExtras).toEqual(['proxy']);
  });

  it('does not read a differently cased root as an item, and ignores the walk when the root has items', () => {
    const files = new Map([
      ['OpenCollection.YML', 'opencollection: "1.0.0"\ninfo: {name: x}\n'],
      ['a.yml', 'info: {name: A, type: http}\n'],
    ]);
    const c = parseOpenCollection(files.get('OpenCollection.YML')!, files, 'OpenCollection.YML');
    expect(c.items.map((i) => i.info.name)).toEqual(['A']);
    const withItems = parseOpenCollection('opencollection: "1.0.0"\ninfo: {name: x}\nitems: []\n', files);
    expect(withItems.items).toEqual([]);
  });

  it('sorts by seq, missing last, ties in file order rather than by name', () => {
    const files = new Map([
      ['opencollection.yml', 'opencollection: "1.0.0"\ninfo: {name: x}\n'],
      ['a.yml', 'info: {name: Z first, type: http}\n'],
      ['b.yml', 'info: {name: A second, type: http}\n'],
      ['c.yml', 'info: {name: C, type: http, seq: 1}\n'],
    ]);
    const c = parseOpenCollection(files.get('opencollection.yml')!, files);
    expect(c.items.map((i) => i.info.name)).toEqual(['C', 'Z first', 'A second']);
  });

  it('reports a file that does not parse and keeps going', () => {
    const files = new Map([
      ['opencollection.yml', 'opencollection: "1.0.0"\ninfo: {name: x}\n'],
      ['bad.yml', 'info: [unclosed\n'],
      ['ok.yml', 'info: {name: Ok, type: http}\n'],
    ]);
    const c = parseOpenCollection(files.get('opencollection.yml')!, files);
    expect(c.items.map((i) => i.info.name)).toEqual(['Ok']);
    expect(c.configExtras).toEqual(['unreadable:bad.yml']);
  });

  it('lists the features it does not read', () => {
    const c = parseOpenCollection(
      'opencollection: "1.0.0"\ninfo: {name: x}\nconfig:\n  proxy: {}\n  clientCertificates: []\n  environments:\n    - name: e\n      extends: base\n      dotEnvFilePath: .env\n',
    );
    expect(c.configExtras).toEqual(['proxy', 'clientCertificates']);
    expect(c.environments[0]?.extras).toEqual(['extends', 'dotEnvFilePath']);
  });

  it('refuses another major version', () => {
    expect(() => parseOpenCollection('opencollection: "2.0.0"\ninfo: {name: x}\n')).toThrow(/2\.0\.0/);
    expect(() => parseOpenCollection('opencollection: "2.0.0"\ninfo: {name: x}\n')).toThrow(OpenCollectionError);
  });

  it('refuses malformed YAML and a document that is not a collection', () => {
    const code = (text: string): unknown => {
      try {
        parseOpenCollection(text);
      } catch (e) {
        return (e as OpenCollectionError).code;
      }
      return undefined;
    };
    expect(code('a: [unclosed')).toBe('oc-malformed');
    expect(code('openapi: "3.0.0"\n')).toBe('oc-not-collection');
    expect(code('- just\n- a list\n')).toBe('oc-not-collection');
  });

  it('stops at an absurd nesting depth', () => {
    let text = 'opencollection: "1.0.0"\ninfo: {name: x}\nitems:\n';
    const deep = (n: number): string => {
      let inner = '{info: {name: leaf}}';
      for (let i = 0; i < n; i += 1) inner = `{info: {name: f}, items: [${inner}]}`;
      return inner;
    };
    text += `  - ${deep(100)}\n`;
    expect(() => parseOpenCollection(text)).toThrow(/deeper/);
  });
});

describe('isOpenCollection', () => {
  it('needs a string version key', () => {
    expect(isOpenCollection({ opencollection: '1.0.0' })).toBe(true);
    expect(isOpenCollection({ opencollection: 1 })).toBe(false);
    expect(isOpenCollection([])).toBe(false);
    expect(isOpenCollection(null)).toBe(false);
  });
});
