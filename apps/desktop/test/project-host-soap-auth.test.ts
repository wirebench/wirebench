// @vitest-environment node
/**
 * `ProjectHost.authFor` resolves a SOAP request's effective token auth through its endpoint's
 * `authMode`, and `soapAuthOf` answers one owner's own configuration for the OAuth2 channels.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';

let server: TestSoapServer;
let root: string;
let host: ProjectHost;
let ids: { readonly interfaceId: string; readonly endpointId: string; readonly requestId: string };

const BEARER = { type: 'bearer', tokenRef: 'sec_endpoint' } as const;
const API_KEY = { type: 'api-key', name: 'key', valueRef: 'sec_request', in: 'query' } as const;

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  root = mkdtempSync(join(tmpdir(), 'wirebench-soap-auth-'));
  host = new ProjectHost(new EngineService());
  await host.create({ dir: join(root, 'p'), name: 'P' });
  await host.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
  const project = host.snapshot()!;
  const iface = project.interfaces[0]!;
  const request = project.requests.find((candidate) => candidate.interfaceId === iface.id)!;
  ids = { interfaceId: iface.id, endpointId: iface.endpoints[0]!.id, requestId: request.id };
  await host.mutate({
    kind: 'update-endpoint-auth',
    interfaceId: ids.interfaceId,
    endpointId: ids.endpointId,
    auth: BEARER,
  });
  await host.mutate({ kind: 'update-request-auth', requestId: ids.requestId, auth: API_KEY });
});

afterEach(async () => {
  await host.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ProjectHost SOAP owner auth', () => {
  it("authFor returns the endpoint's bearer under override, the request's api-key under complement", async () => {
    // An imported endpoint starts in `complement`; `override` is the endpoint's credentials winning.
    await host.mutate({
      kind: 'update-endpoint',
      interfaceId: ids.interfaceId,
      endpointId: ids.endpointId,
      patch: { authMode: 'override' },
    });
    expect(host.authFor(ids.requestId)).toMatchObject(BEARER);

    await host.mutate({
      kind: 'update-endpoint',
      interfaceId: ids.interfaceId,
      endpointId: ids.endpointId,
      patch: { authMode: 'complement' },
    });

    expect(host.authFor(ids.requestId)).toMatchObject(API_KEY);
  });

  it('soapAuthOf finds an interface, an endpoint and a request by id, and nothing for an unknown one', async () => {
    await host.mutate({ kind: 'update-interface-auth', interfaceId: ids.interfaceId, auth: { type: 'none' } });

    expect(host.soapAuthOf(ids.interfaceId)).toEqual({ type: 'none' });
    expect(host.soapAuthOf(ids.endpointId)).toMatchObject(BEARER);
    expect(host.soapAuthOf(ids.requestId)).toMatchObject(API_KEY);
    expect(host.soapAuthOf('01J8NOTHINGATALL')).toBeUndefined();
  });
});
