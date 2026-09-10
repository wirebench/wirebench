// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';

let server: TestSoapServer;

beforeAll(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
});

afterAll(async () => {
  await server.close();
});

/** An engine service whose secret store resolves exactly one ref. */
function serviceWithSecret(ref: string, value: string): EngineService {
  return new EngineService((candidate) => Promise.resolve(candidate === ref ? value : undefined));
}

describe('send with Basic auth', () => {
  it('sends a preemptive Authorization header and returns it redacted unless show-secrets is on', async () => {
    const service = serviceWithSecret('sec_pw', 's3cret!');
    const input = {
      endpoint: `${server.url}/headers`,
      envelopeXml: '<a/>',
      soapVersion: '1.1' as const,
    };
    const auth = { type: 'basic' as const, username: 'alice', passwordRef: 'sec_pw', preemptive: true };

    const redacted = await service.send({ sendId: 'send-auth-1', input }, { auth });

    const recorded = server.requests.filter((request) => request.url.includes('/headers')).at(-1);
    expect(recorded?.headers['authorization']).toBe(`Basic ${Buffer.from('alice:s3cret!', 'utf8').toString('base64')}`);

    // What crosses IPC carries no credential: neither the header map nor the raw bytes.
    expect(redacted.http.request.headers['Authorization'] ?? redacted.http.request.headers['authorization']).toBe(
      '<redacted>',
    );
    expect(Buffer.from(redacted.http.rawRequestBase64, 'base64').toString('utf8')).not.toContain('alice:s3cret!');
    expect(JSON.stringify(redacted)).not.toContain('s3cret!');

    // Main keeps the unredacted copy so a later show-secrets toggle can reveal this exchange.
    const cached = service.exchanges.get('send-auth-1');
    expect(cached?.http.request.headers['Authorization']).toBe(
      `Basic ${Buffer.from('alice:s3cret!', 'utf8').toString('base64')}`,
    );

    // The same send, with the session flag on, shows the real header.
    const shown = await service.send({ sendId: 'send-auth-2', input }, { auth, showSecrets: true });
    const header = shown.http.request.headers['Authorization'] ?? shown.http.request.headers['authorization'];
    expect(header).toBe(`Basic ${Buffer.from('alice:s3cret!', 'utf8').toString('base64')}`);
  });

  it('fails with secret-missing when the auth references a deleted ref', async () => {
    const service = serviceWithSecret('sec_pw', 's3cret!');

    await expect(
      service.send(
        {
          sendId: 'send-auth-3',
          input: { endpoint: `${server.url}/headers`, envelopeXml: '<a/>', soapVersion: '1.1' },
        },
        { auth: { type: 'basic', username: 'alice', passwordRef: 'sec_gone' } },
      ),
    ).rejects.toMatchObject({ code: 'secret-missing' });
  });
});
