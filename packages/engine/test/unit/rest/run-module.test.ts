/** REST's run facet on its own: APIs and webhook items, why a request cannot run, its needs, one send. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createApi, createFolder, createRestRequest, entry } from '../../../src/rest/model.js';
import { restProtocol } from '../../../src/rest/module.js';
import { restRun } from '../../../src/rest/run.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { createWebhookCollection, createWebhookFolder } from '../../../src/webhooks/model.js';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../../../src/rest/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/rest/send.js')>()),
  sendRest: (input: { readonly baseUrl: string; readonly request: { readonly url: string } }) => {
    events.push(`send ${input.baseUrl}${input.request.url}`);
    return Promise.resolve({
      request: { url: `${input.baseUrl}${input.request.url}`, method: 'GET', headers: {} },
      status: 200,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      text: '{}',
      language: 'json',
      cookies: [],
      methodChanged: false,
      durationMs: 1,
    });
  },
}));

const project: Project = {
  ...createProject('REST module', { id: 'proj-rest' }),
  apis: [
    createApi('Billing', {
      id: 'api-billing',
      slug: 'billing',
      order: 1,
      baseUrl: 'https://api.example.test',
      auth: { type: 'bearer', tokenRef: 'ref-token', tokenEnv: 'BILLING_TOKEN' },
      requests: [
        createRestRequest('Zed', { id: 'req-zed', slug: 'zed', order: 1, url: '/zed' }),
        { ...createRestRequest('Gone', { id: 'req-gone', order: 2 }), orphaned: true },
      ],
      folders: [
        createFolder('Invoices', {
          id: 'folder-invoices',
          slug: 'invoices',
          order: 0,
          requests: [
            createRestRequest('List', {
              id: 'req-list',
              slug: 'list',
              url: '/invoices',
              headers: [entry('X-Tenant', '${secret:tenant}')],
            }),
          ],
        }),
      ],
    }),
    createApi('Empty', { id: 'api-empty', slug: 'empty', order: 0 }),
  ],
  webhooks: createWebhookCollection({
    target: 'https://receiver.example.test/hooks',
    signing: {
      mode: 'sign',
      scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
      secretRef: 'ref-hooks',
      secretEnv: 'HOOKS_SIGNING',
    },
    requests: [createRestRequest('Ping', { id: 'hook-ping', slug: 'ping', method: 'POST', url: '/ping' })],
    folders: [
      createWebhookFolder('Orders', {
        id: 'hook-folder',
        slug: 'orders',
        target: 'https://orders.example.test',
        requests: [createRestRequest('Paid', { id: 'hook-paid', slug: 'paid', method: 'POST', url: '/paid' })],
      }),
    ],
  }),
};

const itemAt = (path: string) =>
  restRun
    .groups(project)
    .flatMap((group) => group.candidates)
    .find((candidate) => candidate.item.path === path)?.item;

beforeEach(() => {
  events.length = 0;
});

describe('restRun.groups', () => {
  it('offers one group per API, then the webhook items as a group only a selector reaches', () => {
    expect(restRun.groups(project).map((group) => [group.order, group.name, group.explicitOnly])).toEqual([
      [1, 'Billing', undefined],
      [0, 'Empty', undefined],
      [0, 'Webhooks', true],
    ]);
    expect(restRun.groups({ ...project, apis: [] }).map((group) => group.name)).toEqual(['Webhooks']);
    expect(restRun.groups(createProject('None', { id: 'p0' }))).toEqual([]);
  });

  it('walks an API in explorer order and leaves orphans out', () => {
    const [billing] = restRun.groups(project);
    expect(billing?.candidates.map((candidate) => [candidate.item.path, candidate.diskPath])).toEqual([
      ['Billing/Invoices/List', 'apis/billing/requests/invoices/list'],
      ['Billing/Zed', 'apis/billing/requests/zed'],
    ]);
  });

  it('offers each webhook item against a synthetic API at its effective target, with its signing', () => {
    const hooks = restRun.groups(project)[2]?.candidates ?? [];
    expect(
      hooks.map((candidate) => [
        candidate.item.path,
        candidate.diskPath,
        candidate.item.api.id,
        candidate.item.api.baseUrl,
        candidate.item.signing?.from,
      ]),
    ).toEqual([
      ['Webhooks/Ping', 'webhooks/requests/ping', 'webhooks', 'https://receiver.example.test/hooks', 'collection'],
      [
        'Webhooks/Orders/Paid',
        'webhooks/requests/orders/paid',
        'webhooks',
        'https://orders.example.test',
        'collection',
      ],
    ]);
  });

  it('offers exactly what a run selects of REST', () => {
    expect(restRun.groups(project)[0]?.candidates.map((candidate) => candidate.item)).toEqual(
      selectRequests(project, []).selected,
    );
    expect(restRun.groups(project)[2]?.candidates.map((candidate) => candidate.item)).toEqual(
      selectRequests(project, ['Webhooks']).selected,
    );
  });
});

describe('restRun.whyNotRunnable', () => {
  it('refuses a webhook item, says why an orphan cannot run, and nothing otherwise', () => {
    expect(restRun.whyNotRunnable(project, 'hook-paid')).toBe('A webhook cannot be a sequence step');
    expect(restRun.whyNotRunnable(project, 'req-gone')).toBe('The request is no longer in its contract (orphaned)');
    expect(restRun.whyNotRunnable(project, 'req-list')).toBeUndefined();
    expect(restRun.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });
});

describe('restRun.secretNeeds', () => {
  it('lists the effective auth of an API request, and not its secret tokens', () => {
    const list = itemAt('Billing/Invoices/List');
    expect(list && restRun.secretNeeds(list, project)).toEqual([
      { ref: 'ref-token', envName: 'BILLING_TOKEN', purpose: 'bearer token' },
    ]);
  });

  it('lists a webhook item’s signing secret', () => {
    const ping = itemAt('Webhooks/Ping');
    expect(ping && restRun.secretNeeds(ping, project)).toEqual([
      { ref: 'ref-hooks', envName: 'HOOKS_SIGNING', purpose: 'webhook signing secret (the Webhooks collection)' },
    ]);
  });
});

describe('restRun.open', () => {
  it('prepares, sends once, and reports a REST subject with its exchange and origin', async () => {
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      host: {
        getSecret: (ref) => {
          events.push(`secret ${ref}`);
          return Promise.resolve('abc123def456ghi789');
        },
      },
    };
    const list = itemAt('Billing/Invoices/List');
    const scope = createRunScope(context);
    const sent = list && (await restRun.open(list, scope, context.host, { scope, interactive: false }).result);
    expect(events).toEqual(['secret ref-token', 'secret secret:tenant', 'send https://api.example.test/invoices']);
    expect(sent?.subject).toMatchObject({ protocol: 'rest', status: 200, bodyKind: 'json' });
    expect(sent?.exchange?.kind).toBe('rest');
    expect(sent?.origin).toBe('https://api.example.test');
  });
});

describe('restProtocol', () => {
  it('is the rest kind behind the rest feature, with a run facet', () => {
    expect(restProtocol.kind).toBe('rest');
    expect(restProtocol.feature).toEqual({ id: 'rest', title: 'REST', default: true, stage: 'stable', requires: [] });
    expect(restProtocol.run?.groups(project)).toHaveLength(3);
  });
});
