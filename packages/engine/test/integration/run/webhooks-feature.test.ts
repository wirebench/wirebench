/**
 * The `webhooks` feature in a run (feature switches spec §2.1): a selected webhook item is refused
 * with `feature-disabled`, not sent, when the feature is off; an API request is sent either way, and
 * with the feature on a webhook item is sent as before.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '#core/project/model';
import type { Project } from '#core/project/model';
import type { ProtocolRegistry } from '#core/protocol/registry';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '#protocol-rest/rest/model';
import type { RunContext } from '#core/run/context';
import { runRequests } from '#core/run/run';
import { selectRequests } from '#core/run/select';
import { createWebhookCollection } from '#protocol-rest/webhooks/model';
import { startTestRestServer } from '../../helpers/index.js';
import type { TestRestServer } from '../../helpers/index.js';

let server: TestRestServer;
let dir: string;

beforeAll(async () => {
  server = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-webhooks-feature-'));
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One API with a request, and a webhook collection with one item, both against the test server. */
function project(): Project {
  return {
    ...createProject('Hooks', { id: 'p-hooks' }),
    containers: {
      rest: [
        createApi('Shop', {
          id: 'A1',
          slug: 'shop',
          baseUrl: server.url,
          requests: [createRestRequest('List', { id: 'R1', url: '/echo' })],
        }),
      ],
    },
    protocols: {
      rest: createWebhookCollection({
        target: server.url,
        requests: [createRestRequest('Ping', { id: 'W1', slug: 'ping', method: 'POST', url: '/echo' })],
      }),
    },
  };
}

async function run(selectors: readonly string[], registry: ProtocolRegistry) {
  const p = project();
  const { selected, unmatched } = selectRequests(p, selectors, registry);
  expect(unmatched).toEqual([]);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    host: { getSecret: () => Promise.resolve(undefined) },
    registry,
  };
  return (await runRequests(selected, context)).requests;
}

describe('the webhooks feature in a run', () => {
  it('off: a selected webhook item errors with feature-disabled and is not sent', async () => {
    const results = await run(['Webhooks/Ping'], createBuiltinRegistry({ webhooks: false }));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: 'Webhooks/Ping',
      outcome: 'errored',
      error: { code: 'feature-disabled', message: 'Webhooks is switched off', details: { feature: 'webhooks' } },
    });
  });

  it('off: an API request in the same run is still sent', async () => {
    const results = await run(['Shop/List', 'Webhooks/Ping'], createBuiltinRegistry({ webhooks: false }));
    expect(results.map((result) => [result.path, result.outcome])).toEqual([
      ['Shop/List', 'passed'],
      ['Webhooks/Ping', 'errored'],
    ]);
  });

  it('on: the webhook item is sent', async () => {
    const results = await run(['Webhooks/Ping'], createBuiltinRegistry());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ path: 'Webhooks/Ping', outcome: 'passed' });
    expect(results[0]?.error).toBeUndefined();
  });
});
