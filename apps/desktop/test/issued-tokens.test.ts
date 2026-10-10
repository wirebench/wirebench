// @vitest-environment node
/**
 * The session's issued-token cache and its `issuedTokens.*` channels: a status that says what is
 * cached (the assertion only with show-secrets on), a Fetch now that replaces it and keeps a failure
 * as `lastError`, a Clear that drops it — and the project's lookup of the entry and the request it is
 * fetched for, whose target a send keys under too, so a preview can peek without contacting the STS.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssuedTokenSource, createWssContext } from '@wirebench/engine';
import type { IssuedToken, IssuedTokenTarget, Project, TrustDeps, WssIssuedTokenEntry } from '@wirebench/engine';
import type { IssuedTokenStatusWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { IssuedTokensService } = await import('../src/main/issued-tokens.js');
const { registerIssuedTokenChannels } = await import('../src/main/ipc/issued-tokens.js');
const { EngineService } = await import('../src/main/engine-service.js');
const { ProjectHost } = await import('../src/main/project-host.js');
const { addWssOutgoing } = await import('../src/main/project-wss-mutations.js');
const { desktopSecrets } = await import('../src/main/send/host.js');
const { recordSecretValue } = await import('../src/main/redact.js');

const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_issued" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:sts</saml2:Issuer></saml2:Assertion>';

const entry: WssIssuedTokenEntry = {
  kind: 'issued-token',
  stsUrl: 'https://sts.test/issue',
  soapVersion: '1.2',
  trustVersion: '1.3',
  tokenType: '2.0',
  keyType: 'bearer',
  credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
  requestedLifetimeSeconds: 0,
};
const target: IssuedTokenTarget = { endpointUrl: 'https://svc.test/x', expand: (text) => text };
const deps: TrustDeps = { ctx: createWssContext() };
const locator = { projectId: 'p1', configId: 'c1', entryIndex: 0 };

function issued(): IssuedToken {
  return {
    assertionXml: ASSERTION,
    assertionId: '_issued',
    samlVersion: '2.0',
    keyType: 'bearer',
    expiresAt: new Date(Date.now() + 3_600_000),
    stsHost: 'sts.test',
    cacheKey: '',
  };
}

function service(request: () => Promise<IssuedToken> = () => Promise.resolve(issued())) {
  return new IssuedTokensService(() => Promise.resolve({ entry, target, deps }), createIssuedTokenSource({ request }));
}

describe('IssuedTokensService', () => {
  it('reports none, then valid after a fetch, then none after a clear', async () => {
    const tokens = service();
    expect((await tokens.status(locator, false)).state).toBe('none');
    const fetched = await tokens.fetch(locator, false);
    expect(fetched).toMatchObject({ state: 'valid', samlVersion: '2.0', keyType: 'bearer', stsHost: 'sts.test' });
    expect(fetched.expiresAt).toEqual(expect.any(String));
    expect((await tokens.status(locator, false)).state).toBe('valid');
    expect((await tokens.clear(locator, false)).state).toBe('none');
    expect((await tokens.status(locator, false)).state).toBe('none');
  });

  it('carries the assertion only with show-secrets on', async () => {
    const tokens = service();
    await tokens.fetch(locator, false);
    expect((await tokens.status(locator, false)).assertion).toBeUndefined();
    expect((await tokens.status(locator, true)).assertion).toBe(ASSERTION);
  });

  it('answers a fetch whose request fails with state none and that failure as lastError', async () => {
    const tokens = service(() => Promise.reject(new Error('The token service answered a fault: denied')));
    expect(await tokens.fetch(locator, false)).toEqual({
      state: 'none',
      lastError: 'The token service answered a fault: denied',
    });
  });

  it('masks recorded secret values in lastError unless secrets show', async () => {
    recordSecretValue('pw-quoted-by-the-fault');
    const tokens = service(() => Promise.reject(new Error('denied for pw-quoted-by-the-fault')));
    const hidden = await tokens.fetch(locator, false);
    expect(hidden.lastError).toContain('denied for');
    expect(hidden.lastError).not.toContain('pw-quoted-by-the-fault');
    expect((await tokens.status(locator, true)).lastError).toBe('denied for pw-quoted-by-the-fault');
  });

  it('says a token with no expiry was used once', async () => {
    const tokens = service(() => {
      const noExpiry: { expiresAt?: Date } & Omit<IssuedToken, 'expiresAt'> = issued();
      delete noExpiry.expiresAt;
      return Promise.resolve(noExpiry);
    });
    expect(await tokens.fetch(locator, false)).toMatchObject({ state: 'none', singleUse: true, stsHost: 'sts.test' });
  });

  it('fetches anew on Fetch now even while a token is cached', async () => {
    const request = vi.fn(() => Promise.resolve(issued()));
    const tokens = service(request);
    await tokens.fetch(locator, false);
    await tokens.fetch(locator, false);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('issuedTokens channels', () => {
  beforeEach(() => {
    handlers.clear();
  });

  async function value(channel: string, payload: unknown): Promise<IssuedTokenStatusWire> {
    const result = (await handlers.get(channel)!({ sender: {} }, payload)) as
      { ok: true; value: IssuedTokenStatusWire } | { ok: false; error: unknown };
    if (!result.ok) throw new Error(`${channel} failed: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  it('registers status, fetch and clear, reading show-secrets for every answer', async () => {
    let show = false;
    registerIssuedTokenChannels({ issuedTokens: service(), showSecrets: { get: () => show } });
    expect((await value('issuedTokens.status', locator)).state).toBe('none');
    expect(await value('issuedTokens.fetch', locator)).not.toHaveProperty('assertion');
    show = true;
    expect((await value('issuedTokens.status', locator)).assertion).toBe(ASSERTION);
    expect((await value('issuedTokens.clear', locator)).state).toBe('none');
  });
});

describe('ProjectHost.issuedTokenTarget', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const ENVELOPE =
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

  function withRequests(base: Project, refs: readonly (string | undefined)[]): Project {
    return {
      ...base,
      properties: { ...base.properties, sts: 'https://sts.test/issue' },
      containers: {
        ...base.containers,
        soap: [
          {
            kind: 'soap',
            id: 'i1',
            name: 'I',
            slug: 'i',
            order: 0,
            definitionUrl: 'http://x',
            cacheDefinition: true,
            targetNamespace: '',
            endpoints: [],
            wsa: { enabled: false, version: '2005/08' },
            operations: [
              {
                name: 'Op',
                bindingName: 'B',
                slug: 'op',
                order: 0,
                requests: refs.map((ref, index) => ({
                  id: `r${String(index + 1)}`,
                  name: `Request ${String(index + 1)}`,
                  slug: `request-${String(index + 1)}`,
                  order: index,
                  envelopeXml: ENVELOPE,
                  endpointUrl: `https://svc.test/${String(index + 1)}`,
                  soapVersion: '1.1',
                  headers: [],
                  attachments: [],
                  ...(ref !== undefined ? { wssOutgoingRef: ref } : {}),
                  properties: { encoding: 'UTF-8' },
                  assertions: [],
                })),
              },
            ],
          },
        ],
      },
    } as unknown as Project;
  }

  async function open(refs: (configId: string) => readonly (string | undefined)[]) {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-issued-'));
    dirs.push(dir);
    const host = new ProjectHost(new EngineService(), {}, undefined, undefined, {
      get: (ref) => Promise.resolve(ref === 'sec' ? 'hunter2' : undefined),
    });
    await host.create({ dir, name: 'Demo' });
    const state = (host as unknown as { open: { project: Project } }).open;
    const added = addWssOutgoing(state.project, { name: 'Tokens' });
    state.project = withRequests(added.project, refs(added.configId));
    await host.mutate({
      kind: 'update-wss-outgoing',
      configId: added.configId,
      patch: {
        entries: [
          { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
          { ...entry, stsUrl: '${#Project#sts}' },
        ],
      },
    });
    return { host, configId: added.configId, projectId: state.project.id };
  }

  it('finds the entry and the first request that selects the configuration, as a send targets it', async () => {
    const { host, configId, projectId } = await open((id) => [undefined, id]);
    const resolved = await host.issuedTokenTarget(projectId, configId, 1);
    expect(resolved.entry).toMatchObject({ kind: 'issued-token', stsUrl: '${#Project#sts}' });
    expect(resolved.target.endpointUrl).toBe('https://svc.test/2');
    expect(resolved.target.expand(resolved.entry.stsUrl)).toBe('https://sts.test/issue');
    expect(await resolved.deps.ctx.secrets('sec')).toBe('hunter2');
  });

  it('uses the request the caller names', async () => {
    const { host, configId, projectId } = await open((id) => [id, id]);
    expect((await host.issuedTokenTarget(projectId, configId, 1, 'r2')).target.endpointUrl).toBe('https://svc.test/2');
  });

  it('refuses a named request that does not select the configuration', async () => {
    const { host, configId, projectId } = await open((id) => [undefined, id]);
    await expect(host.issuedTokenTarget(projectId, configId, 1, 'r1')).rejects.toMatchObject({
      code: 'ws-trust-no-request',
    });
  });

  it("resolves secrets through the send's getter, so a ref only it knows works for Fetch now", async () => {
    const { host, configId, projectId } = await open((id) => [id]);
    const sendGetter = desktopSecrets(
      { secretsFor: () => (ref) => Promise.resolve(ref === 'team:sts-password' ? 'from-team' : undefined) },
      projectId,
    );
    const resolved = await host.issuedTokenTarget(projectId, configId, 1, undefined, sendGetter);
    expect(await resolved.deps.ctx.secrets('team:sts-password')).toBe('from-team');
    // The keychain alone does not know it: without the send's getter the ref refuses.
    const keychainOnly = await host.issuedTokenTarget(projectId, configId, 1);
    await expect(keychainOnly.deps.ctx.secrets('team:sts-password')).rejects.toMatchObject({ code: 'secret-missing' });
  });

  it('refuses an entry that is not an issued token', async () => {
    const { host, configId, projectId } = await open((id) => [id]);
    await expect(host.issuedTokenTarget(projectId, configId, 0)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses with ws-trust-no-request when no request selects the configuration', async () => {
    const { host, configId, projectId } = await open(() => [undefined]);
    await expect(host.issuedTokenTarget(projectId, configId, 1)).rejects.toMatchObject({
      code: 'ws-trust-no-request',
      message: 'Select this configuration on a request first.',
    });
  });

  it('previews a placeholder naming the STS host, and never contacts the STS', async () => {
    const { host } = await open((id) => [id]);
    const request = vi.fn(() => Promise.resolve(issued()));
    host.setIssuedTokens(createIssuedTokenSource({ request }));
    const preview = await host.previewOutgoingWss('r1', ENVELOPE);
    expect(preview).toContain('<!-- issued token: fetched from sts.test at send -->');
    expect(preview).toContain('ID="_preview"');
    expect(request).not.toHaveBeenCalled();
  });

  it('previews the cached token once one is fetched for the request', async () => {
    const { host, configId, projectId } = await open((id) => [id]);
    const source = createIssuedTokenSource({ request: () => Promise.resolve(issued()) });
    host.setIssuedTokens(source);
    const resolved = await host.issuedTokenTarget(projectId, configId, 1);
    await source.get(resolved.entry, resolved.target, resolved.deps);
    const preview = await host.previewOutgoingWss('r1', ENVELOPE);
    expect(preview).toContain('ID="_issued"');
    expect(preview).not.toContain('_preview');
  });
});
