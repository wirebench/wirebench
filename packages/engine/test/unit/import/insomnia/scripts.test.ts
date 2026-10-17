import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { mapInsomnia } from '../../../../src/import/insomnia/map.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import { apiFolders, apiRequests } from '../../../../src/rest/model.js';

function mapV5(collection: unknown[], extra: Record<string, unknown> = {}): MappedClientImport {
  let n = 0;
  const text = JSON.stringify({ type: 'collection.insomnia.rest/5.0', name: 'W', collection, ...extra });
  return mapInsomnia(parseInsomnia(text), { newId: () => `id${String((n += 1))}` });
}

function request(name: string, scripts: Record<string, string>): Record<string, unknown> {
  return {
    name,
    method: 'GET',
    url: 'https://a.example.com/x',
    meta: { id: `req_${name}` },
    scripts,
  };
}

describe('Insomnia scripts are attached', () => {
  it('a request script is attached with api insomnia, enabled false', () => {
    const mapped = mapV5([
      request('Ping', {
        preRequest: "insomnia.variables.set('a', 1);",
        afterResponse: 'insomnia.test("ok", () => {});',
      }),
    ]);
    const [ping] = apiRequests(mapped.collections[0]!.rest!);
    expect(ping!.scripts).toEqual({
      pre: { text: "insomnia.variables.set('a', 1);\n" },
      post: { text: 'insomnia.test("ok", () => {});\n' },
      api: 'insomnia',
      enabled: false,
      secrets: [],
    });
  });

  it('a folder script is attached at folder level', () => {
    const mapped = mapV5([
      {
        name: 'Orders',
        meta: { id: 'fld_1' },
        scripts: { preRequest: "console.log('folder');" },
        children: [request('Ping', {})],
      },
    ]);
    const api = mapped.collections[0]!.rest!;
    const [folder] = apiFolders(api);
    expect(folder!.scripts).toMatchObject({
      pre: { text: "console.log('folder');\n" },
      api: 'insomnia',
      enabled: false,
    });
    expect(apiRequests(api)[0]!.scripts).toBeUndefined();
  });

  it('a workspace script is attached to the API', () => {
    const mapped = mapV5([request('Ping', {})], { scripts: { preRequest: "console.log('root');" } });
    expect(mapped.collections[0]!.rest!.scripts).toMatchObject({
      pre: { text: "console.log('root');\n" },
      api: 'insomnia',
      enabled: false,
    });
  });

  it('no imported-scripts files are written', () => {
    const mapped = mapV5([request('Ping', { preRequest: 'insomnia.variables.set("a", 1);' })]);
    expect(mapped.scripts).toEqual([]);
    expect(mapped.counts.scripts).toBe(0);
    expect(mapped.report.notes.some((n) => n.includes('imported-scripts'))).toBe(false);
  });

  it('the report says scripts were imported switched off and lists unsupported calls per request', () => {
    const mapped = mapV5([
      request('Fetch', {
        preRequest: "insomnia.sendRequest('https://x', () => {}); const _ = require('lodash'); $.vault.get('k');",
      }),
      request('Plain', { preRequest: 'insomnia.variables.set("a", 1);' }),
    ]);
    expect(mapped.report.warnings).toContain(
      'Scripts on 2 requests were imported switched off: read each on its Scripts tab, then switch them on',
    );
    const line = mapped.report.warnings.find((w) => w.includes('call what Wirebench does not run'));
    expect(line).toBe(
      'The scripts of "Fetch" call what Wirebench does not run: insomnia.sendRequest, insomnia.vault, require',
    );
    expect(mapped.report.warnings.join('\n')).not.toContain('Plain" call');
  });

  it('cookie reads are not flagged, cookie writes are', () => {
    const mapped = mapV5([
      request('Read', { preRequest: "insomnia.cookies.get('a');" }),
      request('Write', { preRequest: "insomnia.cookies.set('a', 'b');" }),
    ]);
    const lines = mapped.report.warnings.filter((w) => w.includes('call what Wirebench does not run'));
    expect(lines).toEqual(['The scripts of "Write" call what Wirebench does not run: insomnia.cookies writes']);
  });
});
