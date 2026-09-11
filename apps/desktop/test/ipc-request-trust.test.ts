/**
 * `WIREBENCH_E2E_EXTRA_CA_FILE`: the e2e-only trust hook.
 *
 * It exists so the Playwright suite can reach a TLS server signed by a CA it generates at run
 * time *without* weakening verification and without a client keystore doubling as a trust store.
 * These tests pin both halves of that: the anchors are appended to `tls.ca` when the variable is
 * set, and nothing at all changes when it is not.
 *
 * The module memoises the file after the first read, so each case loads it fresh through
 * `vi.resetModules()` with the environment already in place.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropertyScopes } from '@wirebench/engine';
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

const ANCHOR = '-----BEGIN CERTIFICATE-----\nTEST-CA\n-----END CERTIFICATE-----\n';

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

function anchorFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-trust-'));
  dirs.push(dir);
  const path = join(dir, 'test-ca.pem');
  writeFileSync(path, ANCHOR, 'utf-8');
  return path;
}

/** The TLS options a captured send went out with. */
interface SentTls {
  readonly ca?: readonly string[];
  readonly rejectUnauthorized?: boolean;
}

/** Registers the channels against a stubbed engine; every send lands in `sent`. */
async function register(sent: SentTls[]): Promise<void> {
  const { registerRequestChannels } = await import('../src/main/ipc/request.js');
  const engine = new EngineService();
  const response = {
    sendId: 'send-1',
    durationMs: 1,
    http: {
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      bodyBase64: '',
      rawBodyBase64: '',
      rawRequestBase64: '',
      rawResponseBase64: '',
      truncated: false,
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
      redirects: [],
      request: { url: 'https://dev.test/soap', method: 'POST', headers: {} },
    },
    problems: [],
  };
  vi.spyOn(engine, 'send').mockImplementation((request) => {
    sent.push((request.input.tls ?? { absent: true }) as SentTls);
    return Promise.resolve(response);
  });
  registerRequestChannels(engine, {
    project: {
      scopesFor: () => scopes,
      preflight: () => ({
        endpoint: 'https://dev.test/soap',
        endpointSource: 'request-endpoint',
        auth: { source: 'none', type: 'none' },
        wsa: { enabled: false },
        unresolved: [],
      }),
      authFor: () => undefined,
      requestMeta: () => undefined,
      projectId: () => undefined,
      requestSource: () => {
        throw new Error('not stubbed');
      },
      buildLiveSendInput: () => {
        throw new Error('not stubbed');
      },
      mutate: () => {
        throw new Error('not stubbed');
      },
      sendInputFor: () => undefined,
      dumpFileFor: () => undefined,
    },
  });
}

async function sendOnce(payload: Record<string, unknown>): Promise<void> {
  const handler = handlers.get('request.send');
  if (handler === undefined) {
    throw new Error('request.send was never registered');
  }
  await handler({ sender: {} }, payload);
}

describe('WIREBENCH_E2E_EXTRA_CA_FILE', () => {
  it('appends the file as an extra trust anchor on a saved request', async () => {
    process.env['WIREBENCH_E2E_EXTRA_CA_FILE'] = anchorFile();
    const sent: SentTls[] = [];
    await register(sent);

    await sendOnce({
      sendId: 'send-1',
      requestId: 'req-1',
      input: { endpoint: 'https://dev.test/soap', envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    expect(sent[0]?.ca).toEqual([ANCHOR]);
    // Verification itself is untouched: the hook adds trust, it never turns checking off.
    expect(sent[0]?.rejectUnauthorized).toBeUndefined();
  });

  it('keeps the anchors the request already carries and adds to them', async () => {
    process.env['WIREBENCH_E2E_EXTRA_CA_FILE'] = anchorFile();
    const sent: SentTls[] = [];
    await register(sent);

    await sendOnce({
      sendId: 'send-1',
      input: { endpoint: 'https://dev.test/soap', envelopeXml: '<a/>', soapVersion: '1.1', tls: { ca: ['OWN'] } },
    });

    expect(sent[0]?.ca).toEqual(['OWN', ANCHOR]);
  });

  it('changes nothing when the variable is unset', async () => {
    const sent: SentTls[] = [];
    await register(sent);

    await sendOnce({
      sendId: 'send-1',
      input: { endpoint: 'https://dev.test/soap', envelopeXml: '<a/>', soapVersion: '1.1' },
    });

    expect(sent[0]).toEqual({ absent: true });
  });
});
