import { describe, expect, it } from 'vitest';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { selectRequests } from '../../../src/run/select.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { EndpointAuth, Interface, Project, SoapRequestDef, WssRef } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestApi } from '../../../src/rest/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';

function soapRequest(extra: Partial<SoapRequestDef> = {}): SoapRequestDef {
  return {
    kind: 'soap',
    id: 'req-soap',
    name: 'Get',
    slug: 'get',
    order: 0,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '<Envelope/>',
    ...extra,
  };
}

function iface(request: SoapRequestDef, auth?: EndpointAuth): Interface {
  return {
    kind: 'soap',
    id: 'iface-billing',
    name: 'Billing',
    slug: 'Billing',
    order: 0,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: false,
    endpoints: [],
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    ...(auth !== undefined ? { auth } : {}),
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [request] }],
  };
}

function project(parts: { interfaces?: Interface[]; apis?: RestApi[]; wss?: Partial<Project['wss']> }): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-1',
    name: 'Test project',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: parts.interfaces ?? [],
    apis: parts.apis ?? [],
    grpcApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [], ...parts.wss },
  };
}

const needsOf = (p: Project) => secretNeedsOf(selectRequests(p, []).selected, p);

describe('secretNeedsOf', () => {
  it("lists a SOAP request's inherited interface auth, used by that request", () => {
    const p = project({
      interfaces: [
        iface(soapRequest(), { type: 'basic', username: 'svc', passwordRef: 'sec_iface', passwordEnv: 'IFACE_PW' }),
      ],
    });
    expect(needsOf(p)).toEqual([
      { ref: 'sec_iface', envName: 'IFACE_PW', purpose: 'basic password for "svc"', usedBy: ['Billing/Op/Get'] },
    ]);
  });

  it('merges two REST requests inheriting one folder auth into one need', () => {
    const api = createApi('demo', {
      id: 'api-1',
      slug: 'demo',
      folders: [
        {
          id: 'f-1',
          name: 'admin',
          slug: 'admin',
          order: 0,
          auth: { type: 'bearer', tokenRef: 'sec_tok' },
          folders: [],
          requests: [
            createRestRequest('a', { id: 'r-a', auth: { type: 'inherit' } }),
            createRestRequest('b', { id: 'r-b', auth: { type: 'inherit' } }),
          ],
        },
      ],
    });
    const needs = needsOf(project({ apis: [api] }));
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ ref: 'sec_tok', purpose: 'bearer token' });
    expect(needs[0]?.usedBy).toHaveLength(2);
    expect(needs[0]?.usedBy.every((path) => path.includes('admin'))).toBe(true);
  });

  it("lists a request's keystore password and its WS-Security password", () => {
    const keystore: WssRef = {
      id: 'ks-1',
      name: 'client',
      document: {
        id: 'ks-1',
        name: 'client',
        path: 'k.pem',
        type: 'pem',
        passwordSecretRef: 'sec_ks',
        passwordEnv: 'KS_PW',
      },
    };
    const outgoing: WssRef = {
      id: 'wss-out',
      name: 'Out',
      document: {
        id: 'wss-out',
        name: 'Out',
        entries: [
          {
            kind: 'username-token',
            username: 'bob',
            passwordRef: 'sec_wss',
            passwordType: 'text',
            addNonce: true,
            addCreated: true,
          },
        ],
      },
    };
    const request = soapRequest({
      properties: { ...DEFAULT_REQUEST_PROPERTIES, sslKeystoreRef: 'ks-1' },
      wssOutgoingRef: 'wss-out',
    });
    const needs = needsOf(
      project({ interfaces: [iface(request)], wss: { keystores: [keystore], outgoing: [outgoing] } }),
    );
    expect(needs).toEqual([
      { ref: 'sec_ks', envName: 'KS_PW', purpose: 'keystore password for "client"', usedBy: ['Billing/Op/Get'] },
      { ref: 'sec_wss', purpose: 'WS-Security password for "bob"', usedBy: ['Billing/Op/Get'] },
    ]);
  });

  it('lists nothing for a request with auth none', () => {
    const api = createApi('demo', {
      id: 'api-1',
      slug: 'demo',
      auth: { type: 'bearer', tokenRef: 'sec_api' },
      requests: [createRestRequest('open', { id: 'r-1', auth: { type: 'none' } })],
    });
    expect(needsOf(project({ apis: [api] }))).toEqual([]);
  });
});
