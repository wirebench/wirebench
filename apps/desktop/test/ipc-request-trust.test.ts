// @vitest-environment node
/**
 * `WIREBENCH_E2E_EXTRA_CA_FILE`: the e2e-only trust hook.
 *
 * It exists so the Playwright suite can reach a TLS server signed by a CA it generates at run
 * time *without* weakening verification and without a client keystore doubling as a trust store.
 * These tests pin both halves of that against a real TLS server signed by such a CA: a send trusts
 * it when the variable names the CA, alongside the anchors main already resolved, and is refused
 * when the variable is unset — verification is never turned off.
 *
 * The module memoises the file after the first read, so each case loads it fresh through
 * `vi.resetModules()` with the environment already in place.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateClientCert,
  generateServerCert,
  generateSecondTestCa,
  generateTestCa,
  startTestSoapServer,
} from '@wirebench/engine/test-helpers';
import type { TestSoapServer } from '@wirebench/engine/test-helpers';
import { createInterface, createProject, createRequest, type Project, type PropertyScopes } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const scopes: PropertyScopes = { project: {}, global: {}, env: {} };

/** The CA the TLS servers below are signed by: trusted only when a send is given it. */
const ANCHOR = generateTestCa().certPem;

/** A client certificate the first CA signed: the project's TLS identity in the resend case. */
const CLIENT = generateClientCert(generateTestCa());

/** A second, unrelated CA: what the CA-bundle preference trusts in the union case. */
const OWN = generateSecondTestCa().certPem;

let server: TestSoapServer;
/** The same CA's server, capped at TLS 1.2: a send whose floor is 1.3 cannot reach it. */
let tls12: TestSoapServer;
/** A server signed by the second CA only. */
let own: TestSoapServer;
/** The first CA's server, asking for a client certificate the same CA signed. */
let mtls: TestSoapServer;

beforeAll(async () => {
  const ca = generateTestCa();
  const leaf = generateServerCert(ca);
  server = await startTestSoapServer({ tls: { cert: leaf.certPem, key: leaf.keyPem } });
  tls12 = await startTestSoapServer({ tls: { cert: leaf.certPem, key: leaf.keyPem, maxVersion: 'TLSv1.2' } });
  const ownLeaf = generateServerCert(generateSecondTestCa());
  own = await startTestSoapServer({ tls: { cert: ownLeaf.certPem, key: ownLeaf.keyPem } });
  mtls = await startTestSoapServer({
    tls: { cert: leaf.certPem, key: leaf.keyPem, ca: ca.certPem, requestCert: true },
  });
});

afterAll(async () => {
  await server.close();
  await tls12.close();
  await own.close();
  await mtls.close();
});

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env['WIREBENCH_E2E_EXTRA_CA_FILE'];
});

beforeEach(() => {
  handlers.clear();
  vi.resetModules();
});

function anchorFile(pem = ANCHOR): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-trust-'));
  dirs.push(dir);
  const path = join(dir, 'test-ca.pem');
  writeFileSync(path, pem, 'utf-8');
  return path;
}

/** A project whose `req-1` is sent to the TLS server. */
function seeded(endpoint = `${server.url}/soap`): Project {
  const request = {
    ...createRequest('Req', { id: 'req-1', envelopeXml: '<a/>', soapVersion: '1.1' }),
    endpointUrl: endpoint,
  };
  const iface = createInterface('Svc', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/x?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [request] }],
  });
  return { ...createProject('P', { id: 'p1' }), interfaces: [iface] };
}

/**
 * Registers the channels over `seeded()`. `trustAnchorsFor` is the CA-bundle preference's anchors,
 * which main resolves for the request's project.
 */
async function register(options: { readonly trustAnchorsFor?: () => Promise<readonly string[]> } = {}): Promise<void> {
  const { registerRequestChannels } = await import('../src/main/ipc/request.js');
  const model = seeded();
  registerRequestChannels(new EngineService(), {
    project: {
      scopesFor: () => scopes,
      preflight: () => ({
        endpoint: `${server.url}/soap`,
        endpointSource: 'request-endpoint',
        auth: { source: 'none', type: 'none' },
        wsa: { enabled: false },
        unresolved: [],
      }),
      requestMeta: () => undefined,
      projectId: () => 'p1',
      runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
      requestSource: () => {
        throw new Error('not stubbed');
      },
      endpointFor: () => {
        throw new Error('not stubbed');
      },
      projectMutate: () => {
        throw new Error('not stubbed');
      },
      dumpFileFor: () => undefined,
      ...(options.trustAnchorsFor !== undefined ? { trustAnchorsFor: options.trustAnchorsFor } : {}),
    } as never,
  });
}

type Reply = { ok: boolean; value?: { http: { status: number } }; error?: { code: string } };

async function sendOnce(payload: Record<string, unknown>): Promise<Reply> {
  const handler = handlers.get('request.send');
  if (handler === undefined) {
    throw new Error('request.send was never registered');
  }
  return (await handler({ sender: {} }, payload)) as Reply;
}

const saved = (url = `${server.url}/soap`) => ({
  sendId: 'send-1',
  requestId: 'req-1',
  input: { endpoint: url, envelopeXml: '<a/>', soapVersion: '1.1' },
});

describe('WIREBENCH_E2E_EXTRA_CA_FILE', () => {
  it('appends the file as an extra trust anchor on a saved request', async () => {
    process.env['WIREBENCH_E2E_EXTRA_CA_FILE'] = anchorFile();
    await register();

    const result = await sendOnce(saved());

    // Trusted through the anchor alone: verification itself is untouched, the hook only adds trust.
    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
  });

  it('keeps the anchors main already resolved and adds to them', async () => {
    // `OWN` comes from `trustAnchorsFor` — the CA-bundle preference — never from the renderer,
    // which cannot name `ca` at all; `ANCHOR` from the file. Each server is trusted by one of them
    // only, so both sends succeeding means the send verifies against the two combined.
    process.env['WIREBENCH_E2E_EXTRA_CA_FILE'] = anchorFile();
    await register({ trustAnchorsFor: () => Promise.resolve([OWN]) });

    expect(await sendOnce(saved(`${own.url}/soap`))).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(await sendOnce(saved())).toMatchObject({ ok: true, value: { http: { status: 200 } } });
  });

  it('changes nothing when the variable is unset', async () => {
    await register();

    const result = await sendOnce({
      sendId: 'send-1',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    // No anchor was added, so the server's certificate is not trusted.
    expect(result).toMatchObject({ ok: false, error: { code: 'tls-untrusted' } });
  });
});

/**
 * The send wire carries one TLS knob and one only: `minVersion`. Trust anchors, a client
 * identity and — above all — `rejectUnauthorized` are main's to decide, from the CA-bundle
 * preference, the selected keystore and the endpoint's own `trustInvalid` flag. A renderer that
 * names any of them is refused by the schema *before* a handler runs, so there is no "was it
 * ignored, or honoured?" to reason about.
 */
describe('the send wire cannot loosen TLS', () => {
  it.each([
    ['rejectUnauthorized', { rejectUnauthorized: false }],
    ['ca', { ca: ['-----BEGIN CERTIFICATE-----'] }],
    ['cert', { cert: 'pem' }],
    ['key', { key: 'pem' }],
    ['passphrase', { passphrase: 'p' }],
    ['servername', { servername: 'evil.test' }],
  ])('rejects a send naming tls.%s, without sending anything', async (_name, tls) => {
    await register();
    const before = server.requests.length;

    const result = await sendOnce({
      sendId: 'send-1',
      input: { endpoint: `${server.url}/soap`, envelopeXml: '<a/>', soapVersion: '1.1', tls },
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
    expect(server.requests.length).toBe(before);
  });

  it('still accepts the one knob it owns, tls.minVersion', async () => {
    process.env['WIREBENCH_E2E_EXTRA_CA_FILE'] = anchorFile();
    await register();
    const floor = (url: string) => ({
      sendId: 'send-1',
      input: { endpoint: url, envelopeXml: '<a/>', soapVersion: '1.1', tls: { minVersion: 'TLSv1.3' } },
    });

    const result = await sendOnce(floor(`${server.url}/soap`));

    expect(result.ok).toBe(true);
    // The floor went out: a server that stops at TLS 1.2 cannot meet it.
    const refused = await sendOnce(floor(`${tls12.url}/soap`));
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe('tls');
  });
});

/**
 * A SOAP resend, from History or from the HTTP Log, is the saved request's send as the editor makes
 * it: it trusts the anchors main resolves for the request's project, as `request.send` does.
 */
describe('a SOAP resend trusts the anchors of its project', () => {
  async function resendDeps(endpoint = `${server.url}/soap`) {
    const { toSendDeps } = await import('../src/main/ipc/request.js');
    const model = seeded(endpoint);
    const project = {
      requestMeta: () => undefined,
      projectId: () => 'p1',
      runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
      endpointFor: () => endpoint,
      trustAnchorsFor: () => Promise.resolve([ANCHOR]),
      // The project's client certificate, which the mutual-TLS server asks for.
      clientIdentityFor: () => Promise.resolve({ cert: CLIENT.certPem, key: CLIENT.keyPem }),
    } as never;
    return { project, send: toSendDeps(new EngineService(), { project }) };
  }

  it('from History', async () => {
    const { registerHistoryChannels } = await import('../src/main/ipc/history.js');
    const { project, send } = await resendDeps();
    const entry = {
      id: 'h-1',
      at: '2026-01-01T00:00:00.000Z',
      projectId: 'p1',
      requestId: 'req-1',
      requestName: 'Req',
      interfaceName: 'Svc',
      operationName: 'Op',
      endpoint: `${server.url}/soap`,
      soapVersion: '1.1',
      durationMs: 1,
      ok: true,
      request: { envelopeXml: '<a/>', headers: [] },
      sizeBytes: 1,
    };
    registerHistoryChannels({ get: () => entry } as never, { project, send });

    const result = await handlers.get('history.resend')!({ sender: {} }, { id: 'h-1' });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
  });

  it('from the HTTP Log', async () => {
    const { registerLogChannels } = await import('../src/main/ipc/log.js');
    const { project } = await resendDeps();
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: { project },
      picks: { rememberWrite: () => undefined },
      appVersion: '0.0.0-test',
    });

    const result = await handlers.get('log.resend')!({ sender: {} }, { protocol: 'soap', requestId: 'req-1' });

    expect(result).toMatchObject({ ok: true, value: { protocol: 'soap', exchange: { http: { status: 200 } } } });
  });

  /** Who the mutual-TLS server says connected, from a resend's summary. */
  const peerOf = (result: unknown): { peerAuthorized: boolean; peerCN?: string } =>
    JSON.parse(
      Buffer.from((result as { value: { http: { bodyBase64: string } } }).value.http.bodyBase64, 'base64').toString(),
    ) as { peerAuthorized: boolean; peerCN?: string };

  it('presents the project client certificate, from History and from the HTTP Log', async () => {
    const { registerHistoryChannels } = await import('../src/main/ipc/history.js');
    const { registerLogChannels } = await import('../src/main/ipc/log.js');
    const { project, send } = await resendDeps(`${mtls.url}/tls-info`);
    const entry = {
      id: 'h-1',
      at: '2026-01-01T00:00:00.000Z',
      projectId: 'p1',
      requestId: 'req-1',
      requestName: 'Req',
      interfaceName: 'Svc',
      operationName: 'Op',
      endpoint: `${mtls.url}/tls-info`,
      soapVersion: '1.1',
      durationMs: 1,
      ok: true,
      request: { envelopeXml: '<a/>', headers: [] },
      sizeBytes: 1,
    };
    registerHistoryChannels({ get: () => entry } as never, { project, send });
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: { project },
      picks: { rememberWrite: () => undefined },
      appVersion: '0.0.0-test',
    });

    const fromHistory = await handlers.get('history.resend')!({ sender: {} }, { id: 'h-1' });
    const fromLog = await handlers.get('log.resend')!({ sender: {} }, { protocol: 'soap', requestId: 'req-1' });

    expect(peerOf(fromHistory)).toMatchObject({ peerAuthorized: true, peerCN: 'wirebench-client' });
    const log = fromLog as { value: { exchange: unknown } };
    expect(peerOf({ value: log.value.exchange })).toMatchObject({ peerAuthorized: true, peerCN: 'wirebench-client' });
  });
});
