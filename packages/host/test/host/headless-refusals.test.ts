// @vitest-environment node
/**
 * What a host without the desktop's machine refuses outright (hosted edition spec decision 5, §3.5,
 * §3.10): without `team-secrets` it serves the team-secrets status and nothing that makes or uses a
 * machine key, and without a `shell` it starts no browser sign-in, binding no loopback port and
 * asking no provider first. The desktop, which has every capability and part, keeps all of it.
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpExchange, HttpRequest, OAuth2Auth } from '@wirebench/engine';
import { createHost, type Host } from '../../src/host/create-host.js';
import type { HostPlatform } from '../../src/host/platform.js';
import { OAuth2Service } from '../../src/oauth2.js';
import { createFakePlatform, createHeadlessPlatform } from '../helpers/fake-platform.js';

const hosts: Host[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

async function started(platform: HostPlatform): Promise<Host> {
  const host = await createHost(platform);
  hosts.push(host);
  return host;
}

const TEAM_SECRET_CHANNELS = [
  'teamSecrets.turnOn',
  'teamSecrets.requestAccess',
  'teamSecrets.approve',
  'teamSecrets.decline',
  'teamSecrets.remove',
  'teamSecrets.grantAdmin',
  'teamSecrets.revokeAdmin',
  'teamSecrets.restoreMine',
  'teamSecrets.dismissReplaced',
];

describe('a host without `team-secrets` (decision 5)', () => {
  it('registers teamSecrets.status only; the desktop keeps every team-secrets channel', async () => {
    const server = await started(createHeadlessPlatform());
    expect(server.handlers.has('teamSecrets.status')).toBe(true);
    expect(TEAM_SECRET_CHANNELS.filter((channel) => server.handlers.has(channel))).toEqual([]);
    const desktop = await started(createFakePlatform());
    expect(TEAM_SECRET_CHANNELS.filter((channel) => !desktop.handlers.has(channel))).toEqual([]);
  });
});

/** A port something else already listens on: binding it fails, so a flow that tries says so. */
async function takenPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as { port: number }).port;
}

describe('a host without a `shell` starts no browser sign-in', () => {
  const base: OAuth2Auth = {
    type: 'oauth2',
    grant: 'client-credentials',
    tokenUrl: 'https://idp.example/token',
    clientId: 'app',
    clientSecretRef: 'sec_client',
    scopes: ['read'],
    clientAuth: 'basic',
    pkce: false,
  };
  const refusal = { code: 'host-capability-missing', details: { capability: 'shell' } };

  function service(port: number, sent: HttpRequest[]): OAuth2Service {
    return new OAuth2Service({
      openExternal: () => Promise.reject(new Error('never opened')),
      browserFlows: false,
      callbackPort: () => port,
      send: (request) => {
        sent.push(request);
        const body = new TextEncoder().encode('{"access_token":"tok-0123456789","token_type":"Bearer"}');
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
        } as unknown as HttpExchange);
      },
    });
  }

  it('refuses the authorization-code grant before binding its loopback port', async () => {
    const sent: HttpRequest[] = [];
    const oauth2 = service(await takenPort(), sent);
    const config: OAuth2Auth = { ...base, grant: 'authorization-code', authorizationUrl: 'https://idp.example/auth' };
    await expect(oauth2.fetchToken(config, { credentials: { clientSecret: 's' } })).rejects.toMatchObject(refusal);
    expect(sent).toEqual([]);
  });

  it('refuses the device-code grant before asking the provider for a code', async () => {
    const sent: HttpRequest[] = [];
    const oauth2 = service(await takenPort(), sent);
    const config: OAuth2Auth = {
      ...base,
      grant: 'device-code',
      deviceAuthorizationUrl: 'https://idp.example/device',
    };
    await expect(oauth2.fetchToken(config, { credentials: { clientSecret: 's' } })).rejects.toMatchObject(refusal);
    expect(sent).toEqual([]);
  });

  it('still runs the client-credentials grant', async () => {
    const sent: HttpRequest[] = [];
    const oauth2 = service(await takenPort(), sent);
    await expect(oauth2.fetchToken(base, { credentials: { clientSecret: 's' } })).resolves.toMatchObject({
      state: 'valid',
    });
    expect(sent).toHaveLength(1);
  });
});
