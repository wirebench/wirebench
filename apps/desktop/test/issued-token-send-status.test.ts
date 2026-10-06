// @vitest-environment node
/**
 * A desktop send and the WS-Security panel share one issued-token key: a token a send of a saved
 * request fetches through the session's `IssuedTokensService` is the one the panel's status reports
 * for that request, without asking the token service again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIssuedTokenSource, DEFAULT_PREFERENCES } from '@wirebench/engine';
import type { IssuedToken, requestIssuedToken } from '@wirebench/engine';
import { startTestSoapServer, type TestSoapServer } from '@wirebench/engine/test-helpers';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const { EngineService } = await import('../src/main/engine-service.js');
const { ProjectHost } = await import('../src/main/project-host.js');
const { IssuedTokensService } = await import('../src/main/issued-tokens.js');
const { sendThroughEngine } = await import('../src/main/send/exchange.js');
const { sendDepsFor } = await import('./helpers/send-deps.js');

const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_from-the-send" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:sts</saml2:Issuer></saml2:Assertion>';

function issued(): IssuedToken {
  return {
    assertionXml: ASSERTION,
    assertionId: '_from-the-send',
    samlVersion: '2.0',
    keyType: 'bearer',
    expiresAt: new Date(Date.now() + 3_600_000),
    stsHost: 'sts.test',
    cacheKey: '',
  };
}

let server: TestSoapServer;
beforeAll(async () => {
  server = await startTestSoapServer();
});
afterAll(async () => {
  await server.close();
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('an issued token fetched by a desktop send', () => {
  it("is the token the panel's status reports for that request", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-issued-send-'));
    dirs.push(dir);
    const host = new ProjectHost(new EngineService(), {}, undefined, undefined, {
      get: (ref) => Promise.resolve(ref === 'sec' ? 'hunter2' : undefined),
    });
    await host.create({ dir, name: 'Demo' });
    const imported = await host.addInterface({ source: { kind: 'url', url: server.wsdlUrl } });
    await host.whenHydrated();
    const requestId = imported.project.requests[0]?.id as string;
    const outgoing = await host.mutate({ kind: 'add-wss-outgoing', name: 'Tokens' });
    const configId = outgoing.createdWssOutgoingId as string;
    await host.mutate({
      kind: 'update-wss-outgoing',
      configId,
      patch: {
        entries: [
          {
            kind: 'issued-token',
            stsUrl: 'https://sts.test/issue',
            soapVersion: '1.2',
            trustVersion: '1.3',
            tokenType: '2.0',
            keyType: 'bearer',
            credential: { kind: 'username', username: 'alice', passwordRef: 'sec' },
            requestedLifetimeSeconds: 0,
          },
        ],
      },
    });
    await host.mutate({ kind: 'update-request', requestId, patch: { wssOutgoingRef: configId } });

    const request = vi.fn<typeof requestIssuedToken>(() => Promise.resolve(issued()));
    const issuedTokens = new IssuedTokensService(
      (locator) => host.issuedTokenTarget(locator.projectId, locator.configId, locator.entryIndex, locator.requestId),
      createIssuedTokenSource({ request }),
    );
    const located = host.runContextFor(requestId);
    if (located === undefined) throw new Error('no project is open');
    const deps = sendDepsFor(located.project, {
      preferences: () => DEFAULT_PREFERENCES,
      issuedTokens,
      project: { runContextFor: (id, envId) => host.runContextFor(id, envId) },
    });

    const summary = await sendThroughEngine(deps, 's1', requestId, { draft: { kind: 'soap' } });
    expect(summary.http.status).toBe(200);
    expect(server.requests.at(-1)?.body.toString('utf8')).toContain('ID="_from-the-send"');

    const locator = { projectId: located.project.id, configId, entryIndex: 0, requestId };
    expect(await issuedTokens.status(locator, false)).toMatchObject({ state: 'valid', stsHost: 'sts.test' });
    expect(request).toHaveBeenCalledTimes(1);
    // A Kerberos credential reaches #40's seam from a send and from the panel's Fetch now alike.
    expect(request.mock.calls[0]?.[2].kerberosToken).toBeTypeOf('function');
    const resolved = await host.issuedTokenTarget(located.project.id, configId, 0, requestId);
    expect(resolved.deps.kerberosToken).toBeTypeOf('function');
    await host.close();
  });
});
