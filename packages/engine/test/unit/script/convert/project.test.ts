/**
 * Converting a project's layered levels (spec §3, §7): every request, folder, API or SOAP interface
 * whose scripts are layered is proposed with its converted text and backup paths, and an accepted
 * proposal switches the level to `wirebench`, keeping everything but the texts and the api. A level
 * edited after it was proposed is refused (Review Focus 4).
 */
import { describe, expect, it } from 'vitest';
import { createProject, type Project } from '#core/project/model';
import { createApi, createFolder, createRestRequest, restApisOf, withRestApis } from '#protocol-rest/rest/model';
import type { RestApi, RestFolder, RestRequestDef } from '#protocol-rest/rest/model';
import { createInterface, createRequest, soapInterfacesOf, withSoapInterfaces } from '#protocol-soap/soap/model';
import type { Interface } from '#protocol-soap/soap/model';
import type { RequestScripts } from '#core/script/model';
import { applyConversions, proposeConversions } from '#core/script/convert/project';

const header = (dialect: string, path: string): string =>
  `// Converted from a ${dialect} script; the original is in ${path}.`;

const API_SCRIPTS: RequestScripts = {
  pre: { text: "bru.setVar('a', '1');\n" },
  api: 'bruno',
  enabled: false,
  secrets: ['signing_key'],
  timeoutMs: 2000,
  postResponseOrder: 'inner-first',
};
const FOLDER_SCRIPTS: RequestScripts = {
  post: { text: "bru.setVar('b', '2');\n" },
  api: 'bruno',
  enabled: true,
  secrets: [],
};
const REQUEST_SCRIPTS: RequestScripts = {
  pre: { text: "bru.setVar('c', '3');\n" },
  post: { text: "bru.setVar('d', '4');\n" },
  api: 'bruno',
  enabled: true,
  secrets: [],
};
const WIREBENCH_SCRIPTS: RequestScripts = {
  pre: { text: "vars.set('e', '5');\n" },
  api: 'wirebench',
  enabled: true,
  secrets: [],
};
const INTERFACE_SCRIPTS: RequestScripts = {
  pre: { text: "pm.environment.set('f', '6');\n" },
  api: 'postman',
  enabled: true,
  secrets: [],
};

function rest(name: string, scripts: RequestScripts | undefined, id: string): RestRequestDef {
  return { ...createRestRequest(name, { id }), ...(scripts !== undefined ? { scripts } : {}) };
}

function sample(): Project {
  const folder: RestFolder = {
    ...createFolder('Carts', { id: 'folder' }),
    scripts: FOLDER_SCRIPTS,
    requests: [rest('Create cart', REQUEST_SCRIPTS, 'request')],
  };
  const shop: RestApi = {
    ...createApi('Shop', { id: 'api' }),
    scripts: API_SCRIPTS,
    folders: [folder],
    requests: [rest('List', WIREBENCH_SCRIPTS, 'typed'), rest('Plain', undefined, 'plain')],
  };
  const other: RestApi = {
    ...createApi('Other', { id: 'other-api', order: 1 }),
    requests: [rest('Ping', REQUEST_SCRIPTS, 'other-request')],
  };
  const soapRequest = {
    ...createRequest('Ask', { id: 'soap-request', envelopeXml: '<e/>', soapVersion: '1.1' }),
    scripts: INTERFACE_SCRIPTS,
  };
  const iface: Interface = {
    ...createInterface('Country', { id: 'iface', definitionUrl: 'http://x/wsdl', order: 2 }),
    scripts: INTERFACE_SCRIPTS,
    operations: [{ name: 'Lookup', bindingName: '{urn:x}B', slug: 'Lookup', order: 0, requests: [soapRequest] }],
  };
  return withSoapInterfaces(withRestApis(createProject('Demo', { id: 'project' }), [shop, other]), [iface]);
}

function shopOf(project: Project): RestApi {
  return restApisOf(project).find((api) => api.id === 'api')!;
}

describe('proposeConversions', () => {
  it('proposals cover request, folder, API and interface levels beneath the root', () => {
    const all = proposeConversions(sample());
    // In explorer order: containers by their shared `order`, a level before the levels inside it.
    expect(all.map((proposal) => proposal.ownerId)).toEqual([
      'api',
      'folder',
      'request',
      'other-request',
      'iface',
      'soap-request',
    ]);
    expect(all.find((proposal) => proposal.ownerId === 'request')?.path).toEqual(['Shop', 'Carts', 'Create cart']);
    expect(all.find((proposal) => proposal.ownerId === 'soap-request')?.path).toEqual(['Country', 'Lookup', 'Ask']);
    expect(all.every((proposal) => proposal.result.ok)).toBe(true);

    expect(proposeConversions(sample(), 'folder').map((proposal) => proposal.ownerId)).toEqual(['folder', 'request']);
    expect(proposeConversions(sample(), 'api').map((proposal) => proposal.ownerId)).toEqual([
      'api',
      'folder',
      'request',
    ]);
    expect(proposeConversions(sample(), 'iface').map((proposal) => proposal.ownerId)).toEqual([
      'iface',
      'soap-request',
    ]);
    expect(proposeConversions(sample(), 'request').map((proposal) => proposal.ownerId)).toEqual(['request']);
    expect(proposeConversions(sample(), 'nothing')).toEqual([]);
  });

  it('a wirebench level is not proposed', () => {
    const ids = proposeConversions(sample()).map((proposal) => proposal.ownerId);
    expect(ids).not.toContain('typed');
    expect(ids).not.toContain('plain');
    expect(proposeConversions(sample(), 'typed')).toEqual([]);
  });

  it('backup paths follow imported-scripts/<api>/<owner>.<phase>.js and avoid taken paths', () => {
    const byId = new Map(proposeConversions(sample()).map((proposal) => [proposal.ownerId, proposal]));
    expect(byId.get('api')?.backups).toEqual([
      { path: 'imported-scripts/shop/shop.pre.js', source: API_SCRIPTS.pre!.text },
    ]);
    expect(byId.get('request')?.backups.map((backup) => backup.path)).toEqual([
      'imported-scripts/shop/shop-carts-create cart.pre.js',
      'imported-scripts/shop/shop-carts-create cart.post.js',
    ]);
    expect(byId.get('iface')?.backups.map((backup) => backup.path)).toEqual([
      'imported-scripts/country/country.pre.js',
    ]);
    const converted = byId.get('request')!.result;
    expect(converted.ok && converted.pre?.split('\n')[0]).toBe(
      header('bruno', 'imported-scripts/shop/shop-carts-create cart.pre.js'),
    );

    // A path on disk already, and two levels in one call whose names slugify alike.
    const twin = sample();
    const shop = shopOf(twin);
    const clash = withRestApis(twin, [
      { ...shop, requests: [...shop.requests, rest('carts-Create cart', REQUEST_SCRIPTS, 'twin')] },
      ...restApisOf(twin).filter((api) => api !== shop),
    ]);
    const taken = new Set(['imported-scripts/shop/shop.pre.js']);
    const again = new Map(proposeConversions(clash, undefined, taken).map((p) => [p.ownerId, p]));
    expect(again.get('api')?.backups.map((backup) => backup.path)).toEqual(['imported-scripts/shop/shop-2.pre.js']);
    expect(again.get('twin')?.backups.map((backup) => backup.path)).toEqual([
      'imported-scripts/shop/shop-carts-create cart-2.pre.js',
      'imported-scripts/shop/shop-carts-create cart-2.post.js',
    ]);
    // The caller's set is read, never written.
    expect([...taken]).toEqual(['imported-scripts/shop/shop.pre.js']);
    // A root does not change the paths a level is given.
    expect(proposeConversions(clash, 'twin', taken)[0]?.backups).toEqual(again.get('twin')?.backups);
  });
});

describe('applyConversions', () => {
  it('apply keeps enabled, secrets, timeoutMs and postResponseOrder', () => {
    const project = sample();
    const proposal = proposeConversions(project, 'api').find((each) => each.ownerId === 'api')!;
    const {
      project: next,
      applied,
      refused,
    } = applyConversions(project, [{ ownerId: 'api', fingerprint: proposal.fingerprint }], new Set());
    expect(refused).toEqual([]);
    expect(applied.map((each) => each.ownerId)).toEqual(['api']);
    expect(applied[0]?.backups).toEqual(proposal.backups);
    const result = proposal.result;
    if (!result.ok) throw new Error('expected the API level to convert');
    expect(shopOf(next).scripts).toEqual({
      pre: { text: result.pre },
      api: 'wirebench',
      enabled: false,
      secrets: ['signing_key'],
      timeoutMs: 2000,
      postResponseOrder: 'inner-first',
    });
    // Only the accepted level changed; the input is left as it was.
    expect(shopOf(next).folders[0]?.scripts).toEqual(FOLDER_SCRIPTS);
    expect(shopOf(project).scripts).toEqual(API_SCRIPTS);
    expect(soapInterfacesOf(next)).toBe(soapInterfacesOf(project));
  });

  it('apply names its backups from the listing it is given, not the review', () => {
    const project = sample();
    const proposal = proposeConversions(project, 'api', new Set()).find((each) => each.ownerId === 'api')!;
    expect(proposal.backups.map((backup) => backup.path)).toEqual(['imported-scripts/shop/shop.pre.js']);
    // Between the review and Accept, a file lands at the path the review showed.
    const listing = new Set(['imported-scripts/shop/shop.pre.js']);
    const { project: next, applied } = applyConversions(
      project,
      [{ ownerId: 'api', fingerprint: proposal.fingerprint }],
      listing,
    );
    expect(applied[0]?.backups.map((backup) => backup.path)).toEqual(['imported-scripts/shop/shop-2.pre.js']);
    expect(shopOf(next).scripts?.pre?.text.split('\n')[0]).toBe(header('bruno', 'imported-scripts/shop/shop-2.pre.js'));
    expect([...listing]).toEqual(['imported-scripts/shop/shop.pre.js']);
  });

  it('a level with no text switches api only', () => {
    const base = sample();
    const orderOnly: RequestScripts = { api: 'bruno', enabled: true, secrets: [], postResponseOrder: 'inner-first' };
    const project = withRestApis(
      base,
      restApisOf(base).map((api) => (api.id === 'api' ? { ...api, scripts: orderOnly } : api)),
    );
    const proposal = proposeConversions(project, 'api')[0]!;
    expect(proposal.ownerId).toBe('api');
    expect(proposal.backups).toEqual([]);
    expect(proposal.result).toEqual({ ok: true, todos: [], mapped: 0 });
    const { project: next, applied } = applyConversions(
      project,
      [{ ownerId: 'api', fingerprint: proposal.fingerprint }],
      new Set(),
    );
    expect(applied).toHaveLength(1);
    expect(shopOf(next).scripts).toEqual({ ...orderOnly, api: 'wirebench' });
  });

  it('a changed level is refused and the others apply', () => {
    const project = sample();
    const proposals = proposeConversions(project, 'api');
    // The request is edited after the review opened.
    const shop = shopOf(project);
    const folder = shop.folders[0]!;
    const edited: RestRequestDef = {
      ...folder.requests[0]!,
      scripts: { ...REQUEST_SCRIPTS, pre: { text: "bru.setVar('c', 'edited');\n" } },
    };
    const changed = withRestApis(
      project,
      restApisOf(project).map((api) =>
        api === shop ? { ...shop, folders: [{ ...folder, requests: [edited] }] } : api,
      ),
    );
    const {
      project: next,
      applied,
      refused,
    } = applyConversions(
      changed,
      [
        ...proposals.map(({ ownerId, fingerprint }) => ({ ownerId, fingerprint })),
        { ownerId: 'typed', fingerprint: 'x' },
        { ownerId: 'gone', fingerprint: 'x' },
      ],
      new Set(),
    );
    expect(refused).toEqual([
      { ownerId: 'request', reason: 'changed' },
      { ownerId: 'typed', reason: 'not-layered' },
      { ownerId: 'gone', reason: 'not-layered' },
    ]);
    expect(applied.map((each) => each.ownerId)).toEqual(['api', 'folder']);
    expect(shopOf(next).scripts?.api).toBe('wirebench');
    expect(shopOf(next).folders[0]?.scripts?.api).toBe('wirebench');
    expect(shopOf(next).folders[0]?.requests[0]?.scripts).toEqual(edited.scripts);
  });

  it('a level that does not parse is never applied', () => {
    const base = sample();
    const broken: RequestScripts = { ...REQUEST_SCRIPTS, post: { text: "bru.setVar('d', ;\n" } };
    const project = withRestApis(
      base,
      restApisOf(base).map((api) =>
        api.id === 'other-api' ? { ...api, requests: [rest('Ping', broken, 'other-request')] } : api,
      ),
    );
    const proposal = proposeConversions(project, 'other-request')[0]!;
    expect(proposal.result).toMatchObject({ ok: false, phase: 'post', line: 1 });
    const {
      project: next,
      applied,
      refused,
    } = applyConversions(project, [{ ownerId: 'other-request', fingerprint: proposal.fingerprint }], new Set());
    expect(applied).toEqual([]);
    expect(refused).toEqual([{ ownerId: 'other-request', reason: 'syntax' }]);
    expect(next).toBe(project);
  });
});

describe('applyConversions with ids that are not unique', () => {
  /** `sample()` with two more REST requests in the Other API, both carrying the id `dup`. */
  function twins(first: RequestScripts, second: RequestScripts): Project {
    const base = sample();
    return withRestApis(
      base,
      restApisOf(base).map((api) =>
        api.id === 'other-api'
          ? { ...api, requests: [...api.requests, rest('Copy A', first, 'dup'), rest('Copy B', second, 'dup')] }
          : api,
      ),
    );
  }
  const otherOf = (project: Project): RestApi => restApisOf(project).find((api) => api.id === 'other-api')!;
  const OTHER_TEXT: RequestScripts = { ...REQUEST_SCRIPTS, pre: { text: "bru.setVar('z', '9');\n" } };

  it('a layered id two levels share is refused and neither level changes', () => {
    const project = twins(REQUEST_SCRIPTS, OTHER_TEXT);
    const proposals = proposeConversions(project).filter((proposal) => proposal.ownerId === 'dup');
    expect(proposals).toHaveLength(2);
    const ping = proposeConversions(project, 'other-request')[0]!;

    // Only the second level is accepted.
    const one = applyConversions(
      project,
      [
        { ownerId: 'dup', fingerprint: proposals[1]!.fingerprint },
        { ownerId: 'other-request', fingerprint: ping.fingerprint },
      ],
      new Set(),
    );
    expect(one.refused).toEqual([{ ownerId: 'dup', reason: 'duplicate-id' }]);
    expect(one.applied.map((each) => each.ownerId)).toEqual(['other-request']);
    const requests = otherOf(one.project).requests;
    expect(requests[0]?.scripts?.api).toBe('wirebench');
    expect(requests.slice(1).map((request) => request.scripts)).toEqual([REQUEST_SCRIPTS, OTHER_TEXT]);

    // Both levels are accepted.
    const both = applyConversions(
      project,
      proposals.map(({ ownerId, fingerprint }) => ({ ownerId, fingerprint })),
      new Set(),
    );
    expect(both.refused).toEqual([{ ownerId: 'dup', reason: 'duplicate-id' }]);
    expect(both.applied).toEqual([]);
    expect(both.project).toBe(project);
  });

  it('a layered level sharing its id with a typed level is refused and neither changes', () => {
    const base = sample();
    // A typed SOAP interface carries the id of the layered request in the Other API.
    const typed = soapInterfacesOf(base).map((iface) => ({
      ...iface,
      id: 'other-request',
      scripts: WIREBENCH_SCRIPTS,
    }));
    const project = withSoapInterfaces(base, typed);
    const ping = proposeConversions(project, 'other-request').find((each) => each.ownerId === 'other-request')!;

    const {
      project: next,
      applied,
      refused,
    } = applyConversions(project, [{ ownerId: 'other-request', fingerprint: ping.fingerprint }], new Set());
    expect(refused).toEqual([{ ownerId: 'other-request', reason: 'duplicate-id' }]);
    expect(applied).toEqual([]);
    expect(next).toBe(project);
    expect(soapInterfacesOf(next)[0]?.scripts).toEqual(WIREBENCH_SCRIPTS);
    expect(otherOf(next).requests[0]?.scripts).toEqual(REQUEST_SCRIPTS);
  });
});
