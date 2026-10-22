import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { eventsOf } from '#core/import/scripts';
import { mapThunderClient } from '../../../../src/import/thunder/convert.js';
import { parseThunderExport, parseThunderFolder } from '../../../../src/import/thunder/parse.js';
import { apiFolders, apiRequests } from '#protocol-rest/rest/model';

type Item = Record<string, unknown>;

function mapCollection(collection: Item): MappedClientImport {
  let n = 0;
  const text = JSON.stringify({
    clientName: 'Thunder Client',
    collectionName: 'Shop',
    folders: [],
    requests: [],
    settings: {},
    ...collection,
  });
  return mapThunderClient(parseThunderExport(text), { newId: () => `id${String((n += 1))}` });
}

function request(name: string, extra: Item = {}): Item {
  return { _id: `r-${name}`, name, url: 'https://a.test/x', method: 'GET', sortNum: 1, ...extra };
}

const inline = (...scripts: string[][]): Item => ({
  inlineScripts: scripts.map((script) => ({ script })),
});

describe('Thunder Client scripts are attached', () => {
  it('inlineScripts lines join into one attached script', () => {
    const mapped = mapCollection({
      requests: [
        request('Ping', {
          preReq: inline(['tc.setVar("a", "1");', 'tc.setVar("b", "2");']),
          postReq: inline(['var json = tc.response.json;', 'tc.setVar("n", json.name);']),
        }),
      ],
    });
    const [ping] = apiRequests(mapped.collections[0]!.rest!);
    expect(ping!.scripts).toEqual({
      pre: { text: 'tc.setVar("a", "1");\ntc.setVar("b", "2");\n' },
      post: { text: 'var json = tc.response.json;\ntc.setVar("n", json.name);\n' },
      api: 'thunder-client',
      enabled: false,
      secrets: [],
    });
  });

  it('the collection pre-request script is on the API level', () => {
    const mapped = mapCollection({
      settings: { preReq: inline(['tc.setVar("root", "1");']) },
      requests: [request('Ping')],
    });
    const api = mapped.collections[0]!.rest!;
    expect(api.scripts).toMatchObject({
      pre: { text: 'tc.setVar("root", "1");\n' },
      api: 'thunder-client',
      enabled: false,
    });
    expect(apiRequests(api)[0]!.scripts).toBeUndefined();
  });

  it('a folder script goes on the folder (the folder key is inferred)', () => {
    const mapped = mapCollection({
      folders: [
        {
          _id: 'f1',
          name: 'Orders',
          containerId: '',
          sortNum: 1,
          settings: { preReq: inline(['tc.setVar("f", "1");']), postReq: inline(['tc.setVar("g", "2");']) },
        },
      ],
      requests: [request('Ping', { containerId: 'f1' })],
    });
    const [folder] = apiFolders(mapped.collections[0]!.rest!);
    expect(folder!.scripts).toMatchObject({
      pre: { text: 'tc.setVar("f", "1");\n' },
      post: { text: 'tc.setVar("g", "2");\n' },
      api: 'thunder-client',
      enabled: false,
    });
  });

  it('a collection with no HTTP request keeps its collection and folder scripts as text', () => {
    let n = 0;
    const idle = {
      colName: 'Idle',
      settings: { preReq: inline(['tc.setVar("root", "1");']) },
      folders: [
        {
          _id: 'f1',
          name: 'Live',
          containerId: '',
          sortNum: 1,
          settings: { postReq: inline(['tc.setVar("g", "2");']) },
        },
      ],
      requests: [request('Feed', { reqType: 'ws', containerId: 'f1' })],
    };
    const busy = { colName: 'Busy', folders: [], requests: [request('Ping')] };
    const files = new Map([
      ['collections/tc_col_idle.json', JSON.stringify(idle)],
      ['collections/tc_col_busy.json', JSON.stringify(busy)],
    ]);
    const mapped = mapThunderClient(parseThunderFolder(files), { newId: () => `id${String((n += 1))}` });
    expect(mapped.collections.map((entry) => entry.name)).toEqual(['Busy']);
    expect(mapped.scripts).toEqual([
      { path: 'imported-scripts/idle/idle.pre.js', source: 'tc.setVar("root", "1");' },
      { path: 'imported-scripts/idle/idle-live.post.js', source: 'tc.setVar("g", "2");' },
    ]);
    expect(mapped.counts.scripts).toBe(2);
    expect(mapped.report.notes).toContain(
      'Idle: its pre script has no place to run in Wirebench, so it was saved to imported-scripts/idle/idle.pre.js and is never run.',
    );
  });

  it('two dropped collections whose names slugify alike keep their files apart', () => {
    let n = 0;
    const idle = (colName: string, script: string) => ({
      colName,
      settings: { preReq: inline([script]) },
      folders: [],
      requests: [],
    });
    const files = new Map([
      ['collections/tc_col_a.json', JSON.stringify(idle('Idle', 'tc.setVar("a", "1");'))],
      ['collections/tc_col_b.json', JSON.stringify(idle('idle', 'tc.setVar("b", "2");'))],
      ['collections/tc_col_c.json', JSON.stringify({ colName: 'Busy', folders: [], requests: [request('Ping')] })],
    ]);
    const mapped = mapThunderClient(parseThunderFolder(files), { newId: () => `id${String((n += 1))}` });
    expect(mapped.scripts).toEqual([
      { path: 'imported-scripts/idle/idle.pre.js', source: 'tc.setVar("a", "1");' },
      { path: 'imported-scripts/idle/idle-2.pre.js', source: 'tc.setVar("b", "2");' },
    ]);
  });

  it('declarative test rows are unchanged', () => {
    const mapped = mapCollection({
      requests: [
        request('Ping', {
          tests: [{ type: 'res-code', custom: '', action: 'equal', value: '200' }],
          postReq: inline(['tc.setVar("a", "1");']),
        }),
      ],
    });
    const [ping] = apiRequests(mapped.collections[0]!.rest!);
    expect(ping!.assertions).toEqual([{ type: 'status', equals: 200 }]);
    expect(mapped.counts.assertions).toBe(1);
  });

  it('no imported-scripts files are written', () => {
    const mapped = mapCollection({
      requests: [request('Ping', { postReq: inline(['tc.setVar("a", "1");']) })],
    });
    expect(mapped.scripts).toEqual([]);
    expect(mapped.counts.scripts).toBe(0);
    const text = [...mapped.report.notes, ...mapped.report.warnings].join('\n');
    expect(text).not.toContain('imported-scripts');
    expect(text).not.toContain('Wirebench does not run them');
  });

  it('the report says scripts were imported switched off and lists unsupported calls', () => {
    const mapped = mapCollection({
      requests: [
        request('Skip', { preReq: inline(['tc.skipRequest();']) }),
        request('Plain', { preReq: inline(['tc.setVar("a", "1");']) }),
      ],
    });
    expect(mapped.report.warnings).toContain(
      'Scripts on 2 requests were imported switched off: read each on its Scripts tab, then switch them on.',
    );
  });
});

describe('eventsOf', () => {
  it('writes prerequest before test and skips blank scripts', () => {
    expect(eventsOf({ post: 'b();', pre: 'a();' })).toEqual({
      event: [
        { listen: 'prerequest', script: { type: 'text/javascript', exec: 'a();' } },
        { listen: 'test', script: { type: 'text/javascript', exec: 'b();' } },
      ],
    });
    expect(eventsOf({ pre: '  \n', post: 'b();' })).toEqual({
      event: [{ listen: 'test', script: { type: 'text/javascript', exec: 'b();' } }],
    });
    expect(eventsOf({})).toEqual({});
  });
});
