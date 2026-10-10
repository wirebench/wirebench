import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CookieJar,
  createApi,
  createProject,
  createRestRequest,
  createSourceCache,
  createWorkspace,
  parseSecretSources,
  jarCookieHost,
  selectRequests,
} from '@wirebench/engine';
import type { RunContext } from '@wirebench/engine';
import { OPEN_GATES } from '../../src/ops/context.js';
import type { OpsContext } from '../../src/ops/context.js';
import type { SendableItem } from '../../src/ops/items.js';
import { sendAndRecord } from '../../src/ops/send.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';

const request = createRestRequest('Me', { id: 'r1', slug: 'me', url: 'http://api.test/me' });
const project = {
  ...createProject('P', { id: 'p1' }),
  containers: { rest: [{ ...createApi('Api', { id: 'a1', slug: 'api' }), requests: [request] }] },
};

const selected = selectRequests(project, ['Api/Me']).selected[0];
if (selected === undefined || selected.kind !== 'rest') {
  throw new Error('the fixture request was not selected');
}
const item: SendableItem = selected;

/** Runs a send that stops at `before`, and returns the host the engine would have been given. */
async function hostFor(cookies: OpsContext['cookies']): Promise<RunContext['host'] | undefined> {
  const context: OpsContext = {
    projectDir: '.',
    historyDir: '.',
    env: {},
    gates: OPEN_GATES,
    origin: 'cli',
    warn: () => undefined,
    secretSources: DEFAULT_CLI_SECRET_SOURCES,
    secretSourceCache: createSourceCache(),
    secretSourceValues: new Set<string>(),
    revealed: new Set(),
    ...(cookies !== undefined ? { cookies } : {}),
  };
  let host: RunContext['host'] | undefined;
  const stop = new Error('stop before sending');
  await sendAndRecord({
    item,
    opened: { project },
    environment: undefined,
    context,
    before: (runContext) => {
      host = runContext.host;
      return Promise.reject(stop);
    },
  }).catch(() => undefined);
  return host;
}

describe('sendAndRecord', () => {
  it('hands the engine a host carrying the process cookie jar', async () => {
    const cookies = jarCookieHost(new CookieJar());
    expect((await hostFor(cookies))?.cookies).toBe(cookies);
  });

  it('lends no jar when the process has none', async () => {
    expect((await hostFor(undefined))?.cookies).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('keeps a source value for later calls of the same base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-send-src-'));
    await writeFile(join(dir, 'vault'), '#!/bin/sh\necho from-vault-long-value\n');
    await chmod(join(dir, 'vault'), 0o755);
    const sources = parseSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } }).sources;
    const secretSourceValues = new Set<string>();
    const context: OpsContext = {
      projectDir: '.',
      historyDir: '.',
      env: { PATH: `${dir}:/usr/bin:/bin` },
      gates: OPEN_GATES,
      origin: 'mcp',
      warn: () => undefined,
      secretSources: { enabled: true, trust: { mode: 'any' } },
      secretSourceCache: createSourceCache(),
      secretSourceValues,
      revealed: new Set(),
    };
    await sendAndRecord({
      item,
      opened: {
        project,
        workspace: { dir: '.', workspace: { ...createWorkspace('W'), secretSources: sources } },
      } as never,
      environment: undefined,
      context,
      before: async (runContext) => {
        await runContext.host.getSecret('secret:db');
        throw new Error('stop before sending');
      },
    }).catch(() => undefined);
    expect([...secretSourceValues]).toContain('from-vault-long-value');
  });
});
