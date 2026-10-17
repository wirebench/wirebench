import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { eventsOf } from '../../../../src/import/scripts.js';
import { mapThunderClient } from '../../../../src/import/thunder/convert.js';
import { parseThunderExport } from '../../../../src/import/thunder/parse.js';
import { apiFolders, apiRequests } from '../../../../src/rest/model.js';

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

  it('a folder script goes on the folder', () => {
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
      'Scripts on 2 requests were imported switched off: read each on its Scripts tab, then switch them on',
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
