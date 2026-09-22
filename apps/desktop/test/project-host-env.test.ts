// @vitest-environment node
/**
 * `ProjectHost` resolving a request under a *named* environment rather than the active one:
 * the REST base URL and property values, the SOAP endpoint, and the SOAP send input all follow
 * the `envId` asked for, and the active environment is never touched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RestApi } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { ProjectHost } from '../src/main/project-host.js';
import type { RestSendResolution } from '../src/main/rest-send.js';

let dir: string;
let host: ProjectHost;
let server: TestSoapServer;

/** Where a resolved REST send goes: its expanded base URL joined to its expanded path. */
function target(resolution: RestSendResolution | undefined): string | undefined {
  return resolution === undefined ? undefined : `${resolution.input.baseUrl}${resolution.input.request.url}`;
}

async function addEnvironment(
  name: string,
  patch: { endpoints?: Record<string, string>; properties?: Record<string, string> },
): Promise<string> {
  const added = await host.mutate({ kind: 'add-environment', name });
  const id = added.project.environments.find((environment) => environment.name === name)?.id as string;
  await host.mutate({ kind: 'update-environment', environmentId: id, patch });
  return id;
}

/** A REST API with one request whose path expands `${#Env#tenant}`, and two environments. */
async function restProject(): Promise<{ requestId: string; dev: string; test: string }> {
  await host.mutate({ kind: 'add-api', name: 'Pets', baseUrl: 'https://api.default' });
  const api = host.model()?.apis[0] as RestApi;
  await host.mutate({ kind: 'add-rest-request', apiId: api.id });
  const request = (host.model()?.apis[0] as RestApi).requests[0];
  const requestId = request?.id as string;
  await host.mutate({ kind: 'update-rest-request', requestId, patch: { url: '/pets/${tenant}' } });
  const dev = await addEnvironment('dev', {
    endpoints: { [api.slug]: 'https://dev.example' },
    properties: { tenant: 'alpha' },
  });
  const test = await addEnvironment('test', {
    endpoints: { [api.slug]: 'https://test.example' },
    properties: { tenant: 'beta' },
  });
  await host.mutate({ kind: 'set-active-environment', environmentId: dev });
  return { requestId, dev, test };
}

beforeEach(async () => {
  server = await startTestSoapServer({ fixture: 'calculator' });
  dir = mkdtempSync(join(tmpdir(), 'wirebench-host-env-'));
  host = new ProjectHost(new EngineService(), {}, undefined, undefined, undefined, undefined, new DialogPicks());
  await host.create({ dir: join(dir, 'project'), name: 'Envs' });
});

afterEach(async () => {
  await host.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ProjectHost under a named environment', () => {
  it('resolves a REST send against the named environment, leaving the active one alone', async () => {
    const { requestId, dev, test } = await restProject();
    const active = host.restSend(requestId);
    expect(target(active)).toBe('https://dev.example/pets/alpha');
    expect(target(host.restSend(requestId, undefined, dev))).toBe(target(active));

    const other = host.restSend(requestId, undefined, test);
    expect(target(other)).toBe('https://test.example/pets/beta');
    expect(other?.baseUrlSource).toBe('environment');
    expect(host.model()?.activeEnvironmentId).toBe(dev);
    expect(target(host.restSend(requestId))).toBe('https://dev.example/pets/alpha');
  });

  it('refuses an environment the project does not have', async () => {
    const { requestId } = await restProject();
    expect(host.restSend(requestId, undefined, 'no-such-env')).toBeUndefined();
  });

  it('resolves a SOAP endpoint and send input under the named environment', async () => {
    await host.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
    await host.whenHydrated();
    const requestId = host.snapshot()?.requests[0]?.id as string;
    const slug = host.snapshot()?.interfaces[0]?.slug as string;
    const dev = await addEnvironment('dev', { endpoints: { [slug]: 'http://dev.example/soap' } });
    const test = await addEnvironment('test', { endpoints: { [slug]: 'http://test.example/soap' } });
    await host.mutate({ kind: 'set-active-environment', environmentId: dev });

    expect(host.endpointFor(requestId)).toBe('http://dev.example/soap');
    expect(host.endpointFor(requestId, test)).toBe('http://test.example/soap');
    expect(host.sendInputFor(requestId)?.endpoint).toBe('http://dev.example/soap');
    expect(host.sendInputFor(requestId, undefined, test)?.endpoint).toBe('http://test.example/soap');
    expect(host.endpointFor(requestId, 'no-such-env')).toBeUndefined();
    expect(host.sendInputFor(requestId, undefined, 'no-such-env')).toBeUndefined();
    expect(host.model()?.activeEnvironmentId).toBe(dev);
  });
});
