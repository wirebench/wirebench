// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest } from '@wirebench/engine';
import type { Project, SoapOwnerAuth } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import { sendDepsFor } from './helpers/send-deps.js';

let server: TestSoapServer;

beforeAll(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
});

afterAll(async () => {
  await server.close();
});

/** One interface holding `req-1` at the server's `/headers`, authenticating with `auth`. */
function seeded(auth: SoapOwnerAuth): Project {
  const request = {
    ...createRequest('Call', { id: 'req-1', envelopeXml: '<a/>', soapVersion: '1.1' }),
    endpointUrl: `${server.url}/headers`,
    auth,
  };
  const iface = createInterface('Svc', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/svc?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Call', bindingName: '{urn:x}B', slug: 'call', order: 0, requests: [request] }],
  });
  return { ...createProject('Demo', { id: 'p1' }), interfaces: [iface] };
}

/** Sends `req-1` through the engine, with a secret store that resolves exactly `sec_pw`. */
function send(model: Project, service: EngineService, sendId: string, show = false) {
  return sendThroughEngine(
    sendDepsFor(model, {
      service,
      getSecret: (ref) => Promise.resolve(ref === 'sec_pw' ? 's3cret!' : undefined),
      showSecrets: { get: () => show },
    }),
    sendId,
    'req-1',
    { draft: { kind: 'soap' } },
  );
}

const BASIC = `Basic ${Buffer.from('alice:s3cret!', 'utf8').toString('base64')}`;

describe('send with Basic auth', () => {
  it('sends a preemptive Authorization header and returns it redacted unless show-secrets is on', async () => {
    const service = new EngineService();
    const model = seeded({ type: 'basic', username: 'alice', passwordRef: 'sec_pw', preemptive: true });

    const redacted = await send(model, service, 'send-auth-1');

    const recorded = server.requests.filter((request) => request.url.includes('/headers')).at(-1);
    expect(recorded?.headers['authorization']).toBe(BASIC);

    // What crosses IPC carries no credential: neither the header map nor the raw bytes.
    expect(redacted.http.request.headers['Authorization'] ?? redacted.http.request.headers['authorization']).toBe(
      '<redacted>',
    );
    expect(Buffer.from(redacted.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain('alice:s3cret!');
    expect(JSON.stringify(redacted)).not.toContain('s3cret!');

    // Main keeps the unredacted copy so a later show-secrets toggle can reveal this exchange.
    const cached = service.exchanges.get('send-auth-1');
    expect(cached?.http.request.headers['Authorization']).toBe(BASIC);

    // The same send, with the session flag on, shows the real header.
    const shown = await send(model, service, 'send-auth-2', true);
    const header = shown.http.request.headers['Authorization'] ?? shown.http.request.headers['authorization'];
    expect(header).toBe(BASIC);
  });

  it('fails with secret-missing when the auth references a deleted ref', async () => {
    await expect(
      send(seeded({ type: 'basic', username: 'alice', passwordRef: 'sec_gone' }), new EngineService(), 'send-auth-3'),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });
});
