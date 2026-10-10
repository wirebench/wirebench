/**
 * Scripts in a run (#63), against local servers: a log-in request's script sets a token the next
 * request sends; a pre-request script signs a body with a listed secret and never sees the
 * request's own secret; a type error or a failing script stops the send; switched-off scripts do
 * not run; a SOAP pre-request script's envelope change is what goes on the wire.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import { DEFAULT_REQUEST_PROPERTIES } from '../../../src/soap/model.js';
import type { Project } from '../../../src/project/model.js';
import type { SoapRequestDef } from '../../../src/soap/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { startTestRestServer, startTestSoapServer } from '../../helpers/index.js';
import type { TestRestServer, TestSoapServer } from '../../helpers/index.js';

const TOKEN = 'tok-9f2e-script';
const SIGNING_KEY = 'sign-me-4471';
const API_KEY = 'api-key-6620';

let rest: TestRestServer;
let soap: TestSoapServer;
let dir: string;
const sandbox = createScriptSandbox();
const checker = createScriptChecker();

beforeAll(async () => {
  rest = await startTestRestServer({ bearerToken: TOKEN });
  soap = await startTestSoapServer({ fixture: 'ws-addressing' });
  dir = mkdtempSync(join(tmpdir(), 'wb-scripts-'));
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

function restRequest(
  name: string,
  order: number,
  input: Parameters<typeof createRestRequest>[1],
  extra: Partial<RestRequestDef> = {},
): RestRequestDef {
  return { ...createRestRequest(name, { id: `rest-${name}`, order, ...input }), ...extra };
}

function project(restRequests: readonly RestRequestDef[], soapRequests: readonly SoapRequestDef[] = []): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-scripts',
    name: 'Scripts',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: { region: 'eu', leaky: '${secret:api_key}' },
    disabledProperties: [],
    containers: {
      soap: [
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
          operations: [
            {
              name: 'Echo',
              bindingName: '{urn:wb:wsa}WsaPolicyBinding',
              slug: 'echo',
              order: 0,
              requests: soapRequests,
            },
          ],
        },
      ],
      rest: [{ ...createApi('Api', { id: 'api-1', slug: 'api', order: 1, baseUrl: '' }), requests: [...restRequests] }],
    },
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
    sequences: [],
    mocks: [],
  } as unknown as Project;
}

interface Run {
  readonly secrets: string[];
  readonly context: RunContext;
}

function contextFor(p: Project): Run {
  const secrets: string[] = [];
  const values: Record<string, string> = { signing_key: SIGNING_KEY, api_key: API_KEY };
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: {
      getSecret: (ref) => Promise.resolve(values[ref.replace(/^secret:/, '')]),
      onSecretValue: (value) => secrets.push(value),
    },
    scripting: new RequestScripting({ sandbox, checker, onSecretValue: (value) => secrets.push(value) }),
  };
  return { secrets, context };
}

async function run(p: Project) {
  const { selected } = selectRequests(p, []);
  const ran = contextFor(p);
  const result = await runRequests(selected, ran.context);
  return { ...ran, result };
}

describe('scripts in a run', () => {
  it('a post-response script sets a token that the next request sends', { timeout: 30_000 }, async () => {
    const login = restRequest(
      'Log in',
      0,
      { url: `${rest.url}/echo?value=${TOKEN}` },
      {
        scripts: scripts({
          post: {
            text: "vars.set('token', (response.json() as { query: { value: string } }).query.value, { secret: true });\ntest('logged in', () => expect(response.status).toBe(200));\n",
          },
        }),
      },
    );
    const me = restRequest(
      'Me',
      1,
      {
        url: `${rest.url}/auth/bearer`,
        headers: [{ name: 'Authorization', value: 'Bearer ${#Sequence#token}', enabled: true }],
      },
      { assertions: [{ type: 'status', equals: 200 }] },
    );
    const { result, secrets } = await run(project([login, me]));
    expect(result.requests.map((r) => [r.name, r.outcome, r.status])).toEqual([
      ['Log in', 'passed', 200],
      ['Me', 'passed', 200],
    ]);
    expect(result.requests[0]?.assertions).toEqual([{ type: 'script', label: 'logged in', outcome: 'passed' }]);
    expect(result.requests[0]?.unasserted).toBe(false);
    expect(secrets).toContain(TOKEN);
  });

  it(
    "a pre-request script signs the body with a listed secret, and never sees the request's own",
    { timeout: 30_000 },
    async () => {
      const body = '{"amount":12}';
      const sign = restRequest(
        'Pay',
        0,
        {
          method: 'POST',
          url: `${rest.url}/echo`,
          headers: [{ name: 'X-Api-Key', value: '${secret:api_key}', enabled: true }],
          body: { kind: 'raw', language: 'json', text: body },
        },
        {
          scripts: scripts({
            secrets: ['signing_key'],
            pre: {
              text: "request.headers.set('X-Sig', crypto.hmac('sha256', secrets.get('signing_key'), request.body.text));\nlog('key header', request.headers.get('X-Api-Key'), String(props.get('region')), String(props.get('leaky')));\n",
            },
            post: {
              text: "const echoed = response.json() as { headers: Record<string, string> };\nvars.set('sig', echoed.headers['x-sig'] ?? '');\nvars.set('key', echoed.headers['x-api-key'] ?? '');\ntest('signed', () => expect(echoed.headers['x-sig']).toBe(request.headers.get('X-Sig') ?? ''));\n",
            },
          }),
        },
      );
      // Fails its own status check on purpose, so the run keeps its exchange to read back.
      const readBack = restRequest(
        'Read back',
        1,
        {
          url: `${rest.url}/echo?sig=\${#Sequence#sig}&key=\${#Sequence#key}`,
        },
        { assertions: [{ type: 'status', equals: 201 }] },
      );
      const { result, secrets } = await run(project([sign, readBack]));
      const pay = result.requests[0]!;
      expect(pay.outcome).toBe('passed');
      expect(pay.assertions.map((a) => [a.label, a.outcome])).toEqual([['signed', 'passed']]);
      const logged = pay.scriptLog?.[0] ?? '';
      expect(logged).toMatch(/^key header wbsec[0-9a-f]+n0z eu undefined$/);
      expect(logged).not.toContain(API_KEY);
      expect(secrets).toContain(SIGNING_KEY);
      // What went on the wire carried the real key and the signature of the body as sent; the second
      // request reads both back from the values the first request's post-response script set.
      const response = result.requests[1]?.exchange?.response ?? '';
      const query = (JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as { query: Record<string, string> })
        .query;
      expect(query).toEqual({ sig: createHmac('sha256', SIGNING_KEY).update(body).digest('hex'), key: API_KEY });
    },
  );

  it('a type error stops the send', { timeout: 30_000 }, async () => {
    const bad = restRequest(
      'Bad',
      0,
      { url: `${rest.url}/echo` },
      {
        scripts: scripts({ post: { text: 'log(response.jsn());\n' } }),
      },
    );
    const { result } = await run(project([bad]));
    expect(result.requests[0]).toMatchObject({
      outcome: 'errored',
      error: { code: 'script-type-error', message: expect.stringContaining('Bad.post.ts:1:14') as unknown },
    });
    expect(result.requests[0]?.status).toBeUndefined();
  });

  it(
    'a failing pre-request script stops the send; a failing post-response one keeps the response',
    { timeout: 30_000 },
    async () => {
      const pre = restRequest(
        'Pre',
        0,
        { url: `${rest.url}/echo` },
        {
          scripts: scripts({ pre: { text: "\nthrow new Error('no send');\n" } }),
        },
      );
      const post = restRequest(
        'Post',
        1,
        { url: `${rest.url}/echo` },
        {
          scripts: scripts({ post: { text: "test('first', () => {});\nthrow new Error('late');\n" } }),
        },
      );
      const { result } = await run(project([pre, post]));
      expect(result.requests[0]).toMatchObject({
        outcome: 'errored',
        error: {
          code: 'script-error',
          message: expect.stringMatching(/^Pre\.pre\.ts:2:\d+: Error: no send$/) as unknown,
        },
      });
      expect(result.requests[0]?.status).toBeUndefined();
      expect(result.requests[1]).toMatchObject({
        outcome: 'errored',
        status: 200,
        error: { code: 'script-error', message: expect.stringContaining('Error: late') as unknown },
        assertions: [{ type: 'script', label: 'first', outcome: 'passed' }],
      });
    },
  );

  it('does not run switched-off scripts', { timeout: 30_000 }, async () => {
    const off = restRequest(
      'Off',
      0,
      { url: `${rest.url}/echo` },
      {
        scripts: scripts({ enabled: false, pre: { text: "throw new Error('should not run');" } }),
        assertions: [{ type: 'status', equals: 200 }],
      },
    );
    const { result } = await run(project([off]));
    expect(result.requests[0]).toMatchObject({ outcome: 'passed', scriptsOff: true });
  });

  it('refuses a request whose script file is missing', { timeout: 30_000 }, async () => {
    const missing = restRequest(
      'Gone',
      0,
      { url: `${rest.url}/echo` },
      {
        scripts: scripts({ pre: { text: '', problem: 'script-file-missing' } }),
      },
    );
    const { result } = await run(project([missing]));
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'script-file-missing' } });
  });

  it('sends the envelope a SOAP pre-request script changed', { timeout: 30_000 }, async () => {
    const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body><w:Echo xmlns:w="urn:wb:wsa"><w:text>hi</w:text></w:Echo></soapenv:Body></soapenv:Envelope>`;
    const request: SoapRequestDef = {
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
      envelopeXml: envelope,
      endpointUrl: `${soap.url}/soap`,
      scripts: scripts({
        pre: {
          text: "request.envelope = request.envelope.replace('<w:text>hi</w:text>', '<w:text>${#Env#nope}</w:text>');\n",
        },
        post: { text: "test('echoed', () => expect(response.envelope).toContain('${#Env#nope}'));\n" },
      }),
    };
    const { result } = await run(project([], [request]));
    expect(result.requests[0]).toMatchObject({
      outcome: 'passed',
      assertions: [{ label: 'echoed', outcome: 'passed' }],
    });
  });
});
