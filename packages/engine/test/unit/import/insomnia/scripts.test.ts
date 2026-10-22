import { describe, expect, it } from 'vitest';
import type { MappedClientImport } from '../../../../src/import/client-import.js';
import { mapInsomnia } from '../../../../src/import/insomnia/map.js';
import { parseInsomnia } from '../../../../src/import/insomnia/parse.js';
import { apiFolders, apiRequests } from '#protocol-rest/rest/model';

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

  it('no imported-scripts files are written', () => {
    const mapped = mapV5([request('Ping', { preRequest: 'insomnia.variables.set("a", 1);' })]);
    expect(mapped.scripts).toEqual([]);
    expect(mapped.counts.scripts).toBe(0);
    expect(mapped.report.notes.some((n) => n.includes('imported-scripts'))).toBe(false);
  });

  it('a workspace with no HTTP request keeps its folder scripts as text', () => {
    const mapped = mapV5([
      {
        name: 'Live',
        meta: { id: 'fld_1' },
        scripts: { preRequest: "console.log('folder');", afterResponse: 'console.log("after");' },
        children: [{ name: 'Feed', url: 'wss://a.example.com/feed', meta: { id: 'ws-req_1' } }],
      },
    ]);
    expect(mapped.collections[0]!.rest).toBeUndefined();
    expect(mapped.scripts).toEqual([
      { path: 'imported-scripts/w/live.pre.js', source: "console.log('folder');" },
      { path: 'imported-scripts/w/live.post.js', source: 'console.log("after");' },
    ]);
    expect(mapped.counts.scripts).toBe(2);
    expect(mapped.report.notes).toContain(
      'Live: its pre script has no place to run in Wirebench, so it was saved to imported-scripts/w/live.pre.js and is never run.',
    );
  });

  it('two dropped workspaces whose names slugify alike keep their files apart', () => {
    let n = 0;
    const workspace = (id: string, name: string, script: string): Record<string, unknown>[] => [
      { _id: id, parentId: null, name, scope: 'collection', _type: 'workspace' },
      { _id: `${id}_f`, parentId: id, _type: 'request_group', name: 'Live', metaSortKey: 1, preRequestScript: script },
    ];
    const busy = [
      { _id: 'wrk_3', parentId: null, name: 'Busy', scope: 'collection', _type: 'workspace' },
      { _id: 'req_1', parentId: 'wrk_3', _type: 'request', name: 'Ping', method: 'GET', url: 'https://a.test/x' },
    ];
    const text = JSON.stringify({
      __export_format: 4,
      resources: [...workspace('wrk_1', 'Idle', 'a();'), ...workspace('wrk_2', 'idle', 'b();'), ...busy],
    });
    const mapped = mapInsomnia(parseInsomnia(text), { newId: () => `id${String((n += 1))}` });
    expect(mapped.scripts.map((file) => file.path)).toEqual([
      'imported-scripts/idle/live.pre.js',
      'imported-scripts/idle/live-2.pre.js',
    ]);
  });

  it('a folder with no HTTP request, inside a workspace that has one, keeps its scripts as text', () => {
    const mapped = mapV5([
      request('Ping', {}),
      {
        name: 'Live',
        meta: { id: 'fld_1' },
        scripts: { preRequest: "console.log('live');" },
        children: [
          {
            name: 'Inner',
            meta: { id: 'fld_2' },
            scripts: { afterResponse: 'console.log("inner");' },
            children: [{ name: 'Feed', url: 'wss://a.example.com/feed', meta: { id: 'ws-req_1' } }],
          },
        ],
      },
    ]);
    expect(apiFolders(mapped.collections[0]!.rest!)).toEqual([]);
    expect(mapped.scripts).toEqual([
      { path: 'imported-scripts/w/live.pre.js', source: "console.log('live');" },
      { path: 'imported-scripts/w/live-inner.post.js', source: 'console.log("inner");' },
    ]);
    expect(mapped.counts.scripts).toBe(2);
    expect(mapped.report.notes).toContain(
      'Live / Inner: its post script has no place to run in Wirebench, so it was saved to imported-scripts/w/live-inner.post.js and is never run.',
    );
  });

  it('the report says scripts were imported switched off and lists unsupported calls per request', () => {
    const mapped = mapV5([
      request('Fetch', {
        preRequest: "insomnia.sendRequest('https://x', () => {}); const _ = require('lodash'); $.vault.get('k');",
      }),
      request('Plain', { preRequest: 'insomnia.variables.set("a", 1);' }),
    ]);
    expect(mapped.report.warnings).toContain(
      'Scripts on 2 requests were imported switched off: read each on its Scripts tab, then switch them on.',
    );
    const line = mapped.report.warnings.find((w) => w.includes('call what Wirebench does not run'));
    expect(line).toBe('The scripts of "Fetch" call what Wirebench does not run: insomnia.vault, require');
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

  it('insomnia.require is reported once, not also as require', () => {
    const mapped = mapV5([request('Req', { preRequest: "insomnia.require('x'); $.require('y');" })]);
    expect(mapped.report.warnings).toContain('The scripts of "Req" call what Wirebench does not run: insomnia.require');
  });

  it('a name that merely ends in insomnia or $ is not flagged', () => {
    const mapped = mapV5([
      request('Lookalike', {
        preRequest: "myinsomnia.vault.get('a'); x$.vault.get('b'); other.insomnia.vault.get('c');",
      }),
    ]);
    expect(mapped.report.warnings.join('\n')).not.toContain('does not run');
  });

  it('sendRequest through insomnia or $ gets the sequence-step advice', () => {
    const mapped = mapV5([
      request('A', { preRequest: "insomnia.sendRequest('u', () => {});" }),
      request('B', { preRequest: "$.sendRequest('u', () => {});" }),
    ]);
    for (const name of ['A', 'B']) {
      expect(
        mapped.report.warnings.some(
          (w) => w.startsWith(`The scripts of "${name}" call `) && w.includes('send that request as a sequence step'),
        ),
      ).toBe(true);
    }
  });

  it('run-control calls through insomnia or $ are reported', () => {
    const mapped = mapV5([
      request('Steer', { afterResponse: "insomnia.execution.setNextRequest('X'); $.execution.skipRequest();" }),
    ]);
    expect(mapped.report.warnings).toContain(
      'The scripts of "Steer" steer the run (insomnia.execution.setNextRequest, insomnia.execution.skipRequest): obeyed in API and folder runs only',
    );
  });
});
