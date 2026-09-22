// @vitest-environment node
/**
 * `request.curl` for a SOAP request whose owner uses a token scheme: the command carries the
 * credential exactly as a send would apply it (`applySoapAuth`), masked unless show-secrets is on,
 * and an OAuth2 token is taken from the cache only — never fetched for an export.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoapOwnerAuth } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

async function curl(): Promise<{ command: string; notes?: string[] }> {
  const result = (await handlers.get('request.curl')!({ sender: {} }, { requestId: 'req-1', shell: 'posix' })) as {
    ok: boolean;
    value?: { command: string; notes?: string[] };
    error?: { code: string; message: string };
  };
  if (!result.ok) {
    throw new Error(`ipc failed: ${result.error?.code} ${result.error?.message}`);
  }
  return result.value!;
}

const secrets: Record<string, string> = { sec_token: 'tok-s3cret', sec_key: 'my key' };

const OAUTH2 = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://auth.example/token',
  clientId: 'cid',
} as SoapOwnerAuth;

describe('request.curl with a SOAP token owner auth', () => {
  let auth: SoapOwnerAuth | undefined;
  let showSecrets: boolean;
  let cached: string | undefined;
  const accessToken = vi.fn(() => Promise.resolve('fetched-token'));

  beforeEach(() => {
    handlers.clear();
    auth = undefined;
    showSecrets = false;
    cached = undefined;
    accessToken.mockClear();
    const project = {
      scopesFor: () => ({ project: {}, global: {}, system: {} }),
      authFor: () => auth,
      buildLiveSendInput: (id: string) =>
        id === 'req-1'
          ? {
              endpoint: 'http://dev.test/calc.asmx',
              envelopeXml: '<Envelope/>',
              soapVersion: '1.1' as const,
              headers: {},
            }
          : undefined,
    };
    registerRequestChannels(new EngineService((ref) => Promise.resolve(secrets[ref])), {
      project: project as unknown as RequestChannelDeps['project'],
      showSecrets: { get: () => showSecrets },
      oauth2: {
        accessToken,
        status: () => (cached === undefined ? { state: 'none' } : { state: 'valid', token: cached }),
      },
    });
  });

  it('a bearer owner shows a redacted Authorization header, and the token with show-secrets', async () => {
    auth = { type: 'bearer', tokenRef: 'sec_token' };

    const redacted = await curl();
    expect(redacted.command).toContain('Authorization: <redacted>');
    expect(redacted.command).not.toContain('tok-s3cret');

    showSecrets = true;
    expect((await curl()).command).toContain('Authorization: Bearer tok-s3cret');
  });

  it('a query api-key appears in the URL, redacted, and in plain with show-secrets', async () => {
    auth = { type: 'api-key', name: 'api key', valueRef: 'sec_key', in: 'query' };

    const redacted = await curl();
    expect(redacted.command).toContain('http://dev.test/calc.asmx?api+key=%3Credacted%3E');
    expect(redacted.command).not.toMatch(/my(%20|\+|\s)key/);

    showSecrets = true;
    expect((await curl()).command).toContain('http://dev.test/calc.asmx?api%20key=my%20key');
  });

  it('a header api-key is masked by its own header name', async () => {
    auth = { type: 'api-key', name: 'X-Service-Key', valueRef: 'sec_key', in: 'header' };

    const redacted = await curl();
    expect(redacted.command).toContain('X-Service-Key: <redacted>');
    expect(redacted.command).not.toContain('my key');
  });

  it('an OAuth2 owner uses a cached token, and never fetches one', async () => {
    auth = OAUTH2;
    showSecrets = true;

    const without = await curl();
    expect(without.command).not.toContain('Authorization');
    expect(without.notes?.join(' ')).toContain('No OAuth2 access token is cached');

    cached = 'cached-token';
    expect((await curl()).command).toContain('Authorization: Bearer cached-token');
    expect(accessToken).not.toHaveBeenCalled();
  });
});
