import { describe, expect, it } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  entry,
} from '@wirebench/engine';
import type { Project, PropertyScopes } from '@wirebench/engine';
import { callbackUrlFor, resolveWebhookSend } from '../src/main/webhook-send.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';

const scopes: PropertyScopes = { project: { webhookTarget: 'https://receiver.test/hooks' }, global: {}, system: {} };

function project(): Project {
  return {
    ...createProject('P', { id: 'p1' }),
    properties: { webhookTarget: 'https://receiver.test/hooks' },
    apis: [
      createApi('Petstore', {
        id: 'api-1',
        baseUrl: 'https://api.test',
        requests: [
          createRestRequest('Subscribe', {
            id: 'parent',
            method: 'POST',
            url: '/subscriptions',
            contract: { method: 'post', path: '/subscriptions' },
          }),
        ],
      }),
    ],
    webhooks: createWebhookCollection({
      requests: [
        createRestRequest('Ping', {
          id: 'w1',
          method: 'POST',
          url: '/ping',
          headers: [entry('X-Id', '${webhookTarget}')],
        }),
      ],
      folders: [
        createWebhookFolder('Petstore', {
          id: 'g1',
          target: 'https://group.test',
          source: { apiId: 'api-1' },
          requests: [
            createRestRequest('newPet', {
              id: 'w2',
              method: 'POST',
              url: '/newPet',
              hook: { kind: 'webhook', name: 'newPet' },
            }),
            createRestRequest('onPetEvent', {
              id: 'w3',
              method: 'POST',
              url: '/onPetEvent',
              hook: {
                kind: 'callback',
                operation: 'post /subscriptions',
                name: 'onPetEvent',
                expression: '{$request.body#/callbackUrl}',
              },
            }),
          ],
        }),
      ],
    }),
  };
}

function sent(body: string): HistoryEntryWire {
  return {
    id: 'h1',
    kind: 'rest',
    at: '2026-09-28T10:42:00.000Z',
    projectId: 'p1',
    requestId: 'parent',
    requestName: 'Subscribe',
    interfaceName: 'Petstore',
    operationName: '',
    endpoint: 'https://api.test/subscriptions',
    soapVersion: 'none',
    method: 'POST',
    status: 201,
    durationMs: 5,
    ok: true,
    request: { envelopeXml: body, headers: [] },
    response: { envelopeXml: '{}', rawHeaders: [], status: 201, statusText: 'Created' },
    sizeBytes: 0,
  };
}

const resolve = (
  p: Project,
  requestId: string,
  newest: (id: string) => HistoryEntryWire | undefined = () => undefined,
) => resolveWebhookSend({ project: p, projectId: 'p1', requestId, scopes, newest });

describe('resolveWebhookSend', () => {
  it('sends a root item to the collection target, expanded', () => {
    const resolution = resolve(project(), 'w1')!;
    expect(resolution.input.baseUrl).toBe('https://receiver.test/hooks');
    expect(resolution.input.request.url).toBe('/ping');
    expect(resolution.input.request.headers[0]?.value).toBe('https://receiver.test/hooks');
    expect(resolution.baseUrlSource).toBe('target');
  });

  it('uses the nearest folder target', () => {
    expect(resolve(project(), 'w2')!.input.baseUrl).toBe('https://group.test');
  });

  it('sends a callback to the URL its parent last sent, unexpanded', () => {
    const body = JSON.stringify({ callbackUrl: 'https://my-app.dev/subs/${notAProperty}' });
    const resolution = resolve(project(), 'w3', (id) => (id === 'parent' ? sent(body) : undefined))!;
    expect(resolution.input.baseUrl).toBe('');
    expect(resolution.input.request.url).toBe('https://my-app.dev/subs/${notAProperty}');
    expect(resolution.baseUrlSource).toBe('callback');
    expect(resolution.unresolved).toEqual([]);
  });

  it('falls back to the target when the parent was never sent', () => {
    const resolution = resolve(project(), 'w3')!;
    expect(resolution.input.baseUrl).toBe('https://group.test');
    expect(resolution.baseUrlSource).toBe('callback-fallback');
  });

  it('refuses an empty target', () => {
    const empty: PropertyScopes = { ...scopes, project: { webhookTarget: '' } };
    const p = { ...project(), properties: { webhookTarget: '' } };
    expect(() =>
      resolveWebhookSend({ project: p, projectId: 'p1', requestId: 'w1', scopes: empty, newest: () => undefined }),
    ).toThrow(expect.objectContaining({ code: 'webhook-target-missing' }));
  });

  it('refuses a target that is not http(s)', () => {
    const odd: PropertyScopes = { ...scopes, project: { webhookTarget: 'ftp://x' } };
    expect(() =>
      resolveWebhookSend({
        project: project(),
        projectId: 'p1',
        requestId: 'w1',
        scopes: odd,
        newest: () => undefined,
      }),
    ).toThrow(expect.objectContaining({ code: 'webhook-target-invalid' }));
  });

  it('answers undefined for an id that is not a webhook item', () => {
    expect(resolve(project(), 'parent')).toBeUndefined();
  });
});

describe('callbackUrlFor', () => {
  it('explains each fallback', () => {
    const p = project();
    const request = p.webhooks!.folders[0]!.requests[1]!;
    expect(callbackUrlFor(p, request, () => undefined)).toEqual({
      url: undefined,
      source: 'callback-fallback',
      detail: 'expression unresolved — never sent',
    });
    expect(callbackUrlFor(p, request, () => sent('{}')).detail).toBe(
      'expression unresolved — $request.body#/callbackUrl has no value',
    );
    expect(callbackUrlFor(p, request, () => sent('{"callbackUrl":"relative/path"}')).detail).toBe(
      'expression unresolved — not an absolute http(s) URL',
    );
    const ok = callbackUrlFor(p, request, () => sent('{"callbackUrl":"https://cb.test/x"}'));
    expect(ok.url).toBe('https://cb.test/x');
    expect(ok.detail).toMatch(/^from your last POST \/subscriptions \(\d\d:\d\d\)$/);
  });
});
