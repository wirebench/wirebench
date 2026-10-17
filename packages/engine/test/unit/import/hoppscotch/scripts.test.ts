import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { mapHoppscotch } from '../../../../src/import/hoppscotch/convert.js';
import { parseHoppscotchCollections } from '../../../../src/import/hoppscotch/parse.js';
import { apiFolders, apiRequests } from '../../../../src/rest/model.js';

type Item = Record<string, unknown>;

function mapCollection(collection: Item): MappedClientImport {
  let n = 0;
  const text = JSON.stringify({ v: 12, name: 'W', folders: [], requests: [], ...collection });
  const { collections, report } = parseHoppscotchCollections(text);
  return mapHoppscotch(collections, report, { newId: () => `id${String((n += 1))}` });
}

function request(name: string, scripts: { pre?: string; test?: string }): Item {
  return {
    v: '17',
    name,
    method: 'GET',
    endpoint: 'https://a.example.com/x',
    params: [],
    headers: [],
    body: { contentType: null, body: null },
    auth: { authType: 'inherit', authActive: true },
    preRequestScript: scripts.pre ?? '',
    testScript: scripts.test ?? '',
    requestVariables: [],
  };
}

describe('Hoppscotch scripts are attached', () => {
  it("a request's pre and test scripts attach with api hoppscotch, enabled false", () => {
    const mapped = mapCollection({
      requests: [request('Ping', { pre: "hopp.env.set('a', '1');", test: 'pw.test("ok", () => {});' })],
    });
    const [ping] = apiRequests(mapped.collections[0]!.rest!);
    expect(ping!.scripts).toEqual({
      pre: { text: "hopp.env.set('a', '1');\n" },
      post: { text: 'pw.test("ok", () => {});\n' },
      api: 'hoppscotch',
      enabled: false,
      secrets: [],
    });
  });

  it('a folder script goes on the folder and a collection script on the API', () => {
    const mapped = mapCollection({
      preRequestScript: "console.log('root');",
      folders: [
        {
          v: 12,
          name: 'Orders',
          folders: [],
          requests: [request('Ping', {})],
          preRequestScript: "console.log('folder');",
          testScript: "console.log('folder test');",
        },
      ],
    });
    const api = mapped.collections[0]!.rest!;
    expect(api.scripts).toMatchObject({ pre: { text: "console.log('root');\n" }, api: 'hoppscotch', enabled: false });
    const [folder] = apiFolders(api);
    expect(folder!.scripts).toMatchObject({
      pre: { text: "console.log('folder');\n" },
      post: { text: "console.log('folder test');\n" },
      api: 'hoppscotch',
      enabled: false,
    });
    expect(apiRequests(api)[0]!.scripts).toBeUndefined();
  });

  it('no imported-scripts files are written', () => {
    const mapped = mapCollection({ requests: [request('Ping', { pre: 'pw.env.set("a", "1")' })] });
    expect(mapped.scripts).toEqual([]);
    expect(mapped.counts.scripts).toBe(0);
    const text = [...mapped.report.notes, ...mapped.report.warnings].join('\n');
    expect(text).not.toContain('imported-scripts');
    expect(text).not.toContain('Wirebench does not run them');
  });

  it('the report says scripts were imported switched off and lists unsupported calls', () => {
    const mapped = mapCollection({
      requests: [
        request('Jar', { pre: "hopp.cookies.get('a'); hopp.fetch('https://x');" }),
        request('Plain', { pre: 'pw.env.set("a", "1")' }),
      ],
    });
    expect(mapped.report.warnings).toContain(
      'Scripts on 2 requests were imported switched off: read each on its Scripts tab, then switch them on',
    );
    const line = mapped.report.warnings.find((w) => w.includes('call what Wirebench does not run'));
    expect(line).toBe('The scripts of "Jar" call what Wirebench does not run: hopp.cookies, hopp.fetch');
    expect(mapped.report.warnings.join('\n')).not.toContain('"Plain" call');
  });
});
