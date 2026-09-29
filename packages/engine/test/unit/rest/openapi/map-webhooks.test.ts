import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  apiFromDocument,
  parseDocumentText,
  parseOpenApiDocument,
  webhookItemsOf,
  webhooksFromDocument,
} from '../../../../src/index.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));
const document = parseOpenApiDocument(parseDocumentText(readFileSync(`${craftedDir}webhooks/openapi.yaml`, 'utf-8')));
let n = 0;
const newId = () => `id${String((n += 1))}`;

describe('webhook items of a document', () => {
  it('lists every webhook and callback method, in document order', () => {
    expect(webhookItemsOf(document).map((item) => [item.key, item.label])).toEqual([
      ['webhook newPet post', 'newPet'],
      ['webhook newPet put', 'newPet (PUT)'],
      ['callback post /subscriptions onPetEvent post', 'onPetEvent · createSubscription'],
      ['callback post /subscriptions broken post', 'broken · createSubscription'],
    ]);
  });
});

describe('webhooksFromDocument', () => {
  it('builds one group named after the API, linked to it', () => {
    const mapped = webhooksFromDocument(document, { apiId: 'api-1', newId, sampleValues: true });
    expect(mapped?.items).toBe(4);
    const folder = mapped!.folder;
    expect(folder.name).toBe('Petstore API');
    expect(folder.source).toEqual({ apiId: 'api-1' });
    expect(folder.target).toBeUndefined();
    const [newPet, replay, onPetEvent] = folder.requests;
    expect([newPet?.method, newPet?.url, newPet?.hook]).toEqual([
      'POST',
      '/newPet',
      { kind: 'webhook', name: 'newPet' },
    ]);
    expect(newPet?.contract).toBeUndefined();
    expect(newPet?.body.kind).toBe('raw');
    expect(newPet?.body.kind === 'raw' ? JSON.parse(newPet.body.text) : undefined).toMatchObject({
      id: 7,
      name: 'Rex',
    });
    expect(replay?.name).toBe('newPet (PUT)');
    expect(new Set(folder.requests.map((r) => r.slug)).size).toBe(folder.requests.length);
    expect(onPetEvent?.hook).toEqual({
      kind: 'callback',
      operation: 'post /subscriptions',
      name: 'onPetEvent',
      expression: '{$request.body#/callbackUrl}',
    });
    expect(onPetEvent?.url).toBe('/onPetEvent');
  });

  it('keeps only the selected items', () => {
    const mapped = webhooksFromDocument(document, { apiId: 'api-1', newId, only: new Set(['webhook newPet post']) });
    expect(mapped?.folder.requests.map((r) => r.name)).toEqual(['newPet']);
    expect(webhooksFromDocument(document, { apiId: 'a', newId, only: new Set() })).toBeUndefined();
  });

  it('counts them in the API summary without changing the API', () => {
    const { api, summary } = apiFromDocument(document, { newId });
    expect(summary.webhooks).toBe(4);
    expect(api.folders.flatMap((f) => f.requests).every((r) => r.hook === undefined)).toBe(true);
  });

  it('surfaces what mapping a webhook operation could not use', () => {
    const withCookie = parseOpenApiDocument(
      parseDocumentText(`
openapi: 3.1.0
info: { title: Cookie API, version: 1.0.0 }
webhooks:
  petMoved:
    post:
      parameters:
        - { name: session, in: cookie, schema: { type: string } }
      responses: { '200': { description: Received } }
`),
    );
    const mapped = webhooksFromDocument(withCookie, { apiId: 'api-1', newId });
    expect(mapped?.skipped).toContainEqual({
      kind: 'parameter',
      where: 'POST petMoved',
      reason: 'Cookie parameter "session" is not imported',
    });
  });
});
