/**
 * Update Definition's plan and apply for a project's imported webhook group: which webhooks and
 * callbacks a new version of the document adds, removes and changes, and how an imported group
 * follows it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyWebhookUpdate,
  createRestRequest,
  parseDocumentText,
  parseOpenApiDocument,
  planRestUpdate,
  planWebhookUpdate,
  webhooksFromDocument,
} from '../../../../src/index.js';
import type { WebhookItemRef } from '../../../../src/index.js';

const dir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/update/', import.meta.url));
const load = (name: string) => parseOpenApiDocument(parseDocumentText(readFileSync(`${dir}${name}`, 'utf-8')));
const old = load('webhooks-old.yaml');
const next = load('webhooks-next.yaml');
let n = 0;
const newId = () => `n${String((n += 1))}`;

describe('planWebhookUpdate', () => {
  it('reports added, removed and changed items', () => {
    const plan = planWebhookUpdate(old, next);
    expect(plan.added.map((item) => item.key)).toEqual(['webhook petDeleted post']);
    expect(plan.removed.map((item) => item.key)).toEqual(['callback post /subscriptions onPetEvent post']);
    expect(plan.changed).toEqual([
      { item: expect.objectContaining({ key: 'webhook newPet post' }) as WebhookItemRef, reasons: ['request-body'] },
    ]);
    expect(planRestUpdate(old, next).webhooks).toEqual(plan);
  });
});

describe('applyWebhookUpdate', () => {
  it('follows the document where untouched, keeps edits, orphans the removed, adds the new', () => {
    const imported = webhooksFromDocument(old, { apiId: 'api-1', newId, sampleValues: true })!.folder;
    const edited = {
      ...imported,
      requests: [
        ...imported.requests.map((request) =>
          request.hook?.kind === 'callback'
            ? { ...request, headers: [{ name: 'X-Mine', value: '1', enabled: true }] }
            : request,
        ),
        createRestRequest('mine', { id: 'hand', slug: 'mine', method: 'POST', url: '/mine' }),
      ],
    };
    const result = applyWebhookUpdate(edited, old, next, { newId });
    const byName = new Map(result.folder.requests.map((request) => [request.name, request]));
    expect(result.added).toBe(1);
    expect(byName.get('petDeleted')?.hook).toEqual({ kind: 'webhook', name: 'petDeleted' });
    expect(byName.get('onPetEvent')?.orphaned).toBe(true);
    expect(byName.get('onPetEvent')?.headers).toEqual([{ name: 'X-Mine', value: '1', enabled: true }]);
    const body = byName.get('newPet')?.body;
    expect(body?.kind === 'raw' ? JSON.parse(body.text) : undefined).toMatchObject({ tag: 'good' });
    expect(byName.get('mine')).toEqual(edited.requests.at(-1));
    expect(result.orphaned).toBe(1);
  });

  it('keeps a body the user edited', () => {
    const imported = webhooksFromDocument(old, { apiId: 'api-1', newId, sampleValues: true })!.folder;
    const edited = {
      ...imported,
      requests: imported.requests.map((request) =>
        request.name === 'newPet'
          ? { ...request, body: { kind: 'raw' as const, language: 'json' as const, text: '{"mine":true}' } }
          : request,
      ),
    };
    const result = applyWebhookUpdate(edited, old, next, { newId });
    const body = result.folder.requests.find((request) => request.name === 'newPet')?.body;
    expect(body).toEqual({ kind: 'raw', language: 'json', text: '{"mine":true}' });
  });

  it('adds only what is new to next, never an item next also had before that the import left unticked', () => {
    const imported = webhooksFromDocument(old, {
      apiId: 'api-1',
      newId,
      only: new Set(['webhook newPet post']),
    })!.folder;
    const result = applyWebhookUpdate(imported, old, next, { newId });
    const names = result.folder.requests.map((request) => request.name);
    expect(names).toContain('petDeleted');
    expect(names).not.toContain('onPetEvent');
  });

  it('never resurrects an item both documents still offer that the group was never given', () => {
    const shared = `openapi: 3.1.0
info: { title: Shared, version: '1' }
webhooks:
  a:
    post: { responses: { '200': { description: ok } } }
  b:
    post: { responses: { '200': { description: ok } } }
`;
    const withA = parseOpenApiDocument(parseDocumentText(shared));
    const withB = parseOpenApiDocument(parseDocumentText(shared));
    const imported = webhooksFromDocument(withA, {
      apiId: 'api-2',
      newId,
      only: new Set(['webhook a post']),
    })!.folder;
    const result = applyWebhookUpdate(imported, withA, withB, { newId });
    expect(result.added).toBe(0);
    expect(result.folder.requests.map((request) => request.name)).toEqual(['a']);
  });
});
