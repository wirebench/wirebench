/**
 * API, interface and folder scripts in a run (#334), against local servers: the levels' pre-request
 * scripts shape what goes on the wire in order, their post-response tests are the request's
 * assertions, the pre-run check names a level's file, a switched-off level does not run, and the
 * secrets a level lists are among what the run needs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createApi, createFolder, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { checkRunScripts, runRequests } from '../../../src/run/run.js';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { selectRequests } from '../../../src/run/select.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { DEFAULT_REQUEST_PROPERTIES } from '../../../src/soap/model.js';
import type { SoapRequestDef } from '../../../src/soap/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { startTestRestServer, startTestSoapServer } from '../../helpers/index.js';
import type { TestRestServer, TestSoapServer } from '../../helpers/index.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const API_KEY = 'api-level-key-5521';

let rest: TestRestServer;
let soap: TestSoapServer;
let dir: string;
const sandbox = createScriptSandbox();
const checker = createScriptChecker();

beforeAll(async () => {
  rest = await startTestRestServer({});
  soap = await startTestSoapServer({ fixture: 'ws-addressing' });
  dir = mkdtempSync(join(tmpdir(), 'wb-level-scripts-'));
});

afterAll(async () => {
  await rest.close();
  await soap.close();
  await sandbox.dispose();
  await checker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const scripts = (extra: Partial<RequestScripts>): RequestScripts => ({
  api: 'wirebench',
  enabled: true,
  secrets: [],
  ...extra,
});

interface Levels {
  readonly api?: RequestScripts;
  readonly folder?: RequestScripts;
  readonly request?: RequestScripts;
  readonly iface?: RequestScripts;
}

function restEcho(own: RequestScripts | undefined): RestRequestDef {
  const request = createRestRequest('Echo', { id: 'rest-echo', url: `${rest.url}/echo` });
  return own !== undefined ? { ...request, scripts: own } : request;
}

function soapEcho(): SoapRequestDef {
  return {
    kind: 'soap',
    id: 'soap-echo',
    name: 'Echo',
    slug: 'Echo',
    order: 0,
    soapVersion: '1.1',
    soapAction: 'urn:wb:wsa:Echo',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><w:Echo xmlns:w="urn:wb:wsa"><w:text>hi</w:text></w:Echo></soapenv:Body></soapenv:Envelope>`,
    endpointUrl: `${soap.url}/soap`,
  };
}

function project(levels: Levels, protocols: { rest?: boolean; soap?: boolean } = { rest: true }): Project {
  const folder = createFolder('Orders', {
    id: 'folder-orders',
    requests: [restEcho(levels.request)],
    ...(levels.folder !== undefined ? { scripts: levels.folder } : {}),
  });
  const api = createApi('Shop', {
    id: 'api-shop',
    slug: 'Shop',
    order: 1,
    folders: [folder],
    ...(levels.api !== undefined ? { scripts: levels.api } : {}),
  });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-levels',
    name: 'Levels',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    containers: {
      soap:
        protocols.soap === true
          ? [
              {
                kind: 'soap',
                id: 'iface-wsa',
                name: 'Wsa',
                slug: 'Wsa',
                order: 0,
                definitionUrl: soap.wsdlUrl,
                cacheDefinition: false,
                endpoints: [],
                wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
                ...(levels.iface !== undefined ? { scripts: levels.iface } : {}),
                operations: [
                  {
                    name: 'Echo',
                    bindingName: '{urn:wb:wsa}WsaPolicyBinding',
                    slug: 'echo',
                    order: 0,
                    requests: [soapEcho()],
                  },
                ],
              },
            ]
          : [],
      rest: protocols.rest === true ? [api] : [],
    },
    environments: [],
    keystores: [],
    sequences: [],
    mocks: [],
  } as unknown as Project;
}

function contextFor(p: Project): RunContext {
  return {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: (ref) => Promise.resolve(ref === 'secret:api_key' ? API_KEY : undefined) },
    scripting: new RequestScripting({ sandbox, checker }),
  };
}

async function run(p: Project) {
  const { selected } = selectRequests(p, []);
  return runRequests(selected, contextFor(p));
}

function echoedHeaders(response: string): Record<string, string> {
  return (JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { headers: Record<string, string> }).headers;
}

describe('level scripts in a run', () => {
  it(
    'run the API’s, then the folder’s, then the request’s scripts around a REST send',
    { timeout: 30_000 },
    async () => {
      const result = await run(
        project({
          api: scripts({
            secrets: ['api_key'],
            pre: {
              text: "request.headers.set('X-Key', secrets.get('api_key')); request.headers.set('X-Order', 'api');",
            },
            post: { text: "test('api: ok', () => expect(response.status).toBe(200));" },
          }),
          folder: scripts({
            pre: { text: "request.headers.set('X-Order', request.headers.get('X-Order') + ',folder');" },
          }),
          request: scripts({
            // Fails on purpose, so the run keeps the exchange for the test to read back.
            post: {
              text: "const sent = (response.json() as { headers: Record<string, string> }).headers;\ntest('request: order', () => expect(sent['x-order']).toBe('api,folder'));\ntest('kept', () => expect(1).toBe(2));",
            },
          }),
        }),
      );
      const echo = result.requests[0]!;
      expect(echo.assertions.map((a) => [a.label, a.outcome])).toEqual([
        ['api: ok', 'passed'],
        ['request: order', 'passed'],
        ['kept', 'failed'],
      ]);
      expect(echoedHeaders(echo.exchange?.response ?? '')).toMatchObject({ 'x-key': API_KEY, 'x-order': 'api,folder' });
    },
  );

  it('run the levels of a request that has no scripts of its own', { timeout: 30_000 }, async () => {
    const result = await run(project({ api: scripts({ post: { text: "test('api', () => expect(1).toBe(1));" } }) }));
    expect(result.requests[0]).toMatchObject({
      outcome: 'passed',
      assertions: [{ label: 'api', outcome: 'passed' }],
      unasserted: false,
    });
    expect(result.requests[0]?.scriptsOff).toBeUndefined();
  });

  it('run nothing for a switched-off level, and say the scripts are off', { timeout: 30_000 }, async () => {
    const result = await run(
      project({ folder: scripts({ enabled: false, pre: { text: "throw new Error('should not run');" } }) }),
    );
    expect(result.requests[0]).toMatchObject({ outcome: 'passed', scriptsOff: true });
  });

  it('run a SOAP interface’s scripts around its requests', { timeout: 30_000 }, async () => {
    const result = await run(
      project(
        {
          iface: scripts({
            pre: {
              text: "request.envelope = request.envelope.replace('<w:text>hi</w:text>', '<w:text>iface</w:text>');",
            },
            post: { text: "test('iface echoed', () => expect(response.envelope).toContain('iface'));" },
          }),
        },
        { soap: true },
      ),
    );
    expect(result.requests[0]).toMatchObject({
      outcome: 'passed',
      assertions: [{ label: 'iface echoed', outcome: 'passed' }],
    });
  });

  it('check every level before the run, naming the level’s file', async () => {
    const p = project({ folder: scripts({ pre: { text: 'log(request.nope);' } }) });
    const errors = await checkRunScripts(selectRequests(p, []).selected, contextFor(p));
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'script-type-error',
        message: expect.stringContaining('Orders/folder.pre.ts:1:') as unknown,
      }),
    ]);
  });

  it('count the secrets a level lists among what the run needs', () => {
    const p = project({ api: scripts({ secrets: ['api_key'], pre: { text: 'log("x");' } }) });
    const needs = secretNeedsOf(selectRequests(p, []).selected, p);
    expect(needs).toEqual([expect.objectContaining({ ref: 'secret:api_key', usedBy: ['Shop/Orders/Echo'] })]);
  });
});
