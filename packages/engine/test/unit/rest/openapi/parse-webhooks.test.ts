import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDocumentText, parseOpenApiDocument } from '../../../../src/index.js';

const craftedDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/', import.meta.url));
const parse = (text: string) => parseOpenApiDocument(parseDocumentText(text));
const crafted = (name: string) => parse(readFileSync(`${craftedDir}${name}/openapi.yaml`, 'utf-8'));

describe('webhooks and callbacks', () => {
  const document = crafted('webhooks');

  it('reads root webhooks, one operation per method, named by the hook', () => {
    expect(document.webhooks?.map((hook) => hook.name)).toEqual(['newPet']);
    const [hook] = document.webhooks ?? [];
    expect(hook?.operations.map((op) => [op.method, op.path])).toEqual([
      ['post', 'newPet'],
      ['put', 'newPet'],
    ]);
    expect(hook?.operations[0]?.requestBody?.content['application/json']).toBeDefined();
  });

  it('reads an operation’s callbacks with their expressions verbatim', () => {
    const create = document.operations.find((op) => op.operationId === 'createSubscription');
    expect(create?.callbacks?.map((cb) => [cb.name, cb.expression, cb.operations.map((op) => op.method)])).toEqual([
      ['onPetEvent', '{$request.body#/callbackUrl}', ['post']],
      ['broken', '{$nope}', ['post']],
    ]);
  });

  it('no longer lists webhooks or callbacks as skipped; extensions still are', () => {
    const kinds = document.skipped.map((entry) => entry.kind);
    expect(kinds).not.toContain('webhook');
    expect(kinds).not.toContain('callback');
    expect(document.skipped).toContainEqual({
      kind: 'extension',
      where: '/webhooks/x-internal',
      reason: 'vendor extensions are not imported',
    });
  });

  it('keeps a 3.0 document’s root webhooks skipped, with the reason', () => {
    const old = parse(
      'openapi: 3.0.3\ninfo: { title: T, version: "1" }\npaths: {}\nwebhooks:\n  a: { post: { responses: {} } }\n',
    );
    expect(old.webhooks ?? []).toEqual([]);
    expect(old.skipped).toContainEqual({ kind: 'webhook', where: '/webhooks/a', reason: 'webhooks need OpenAPI 3.1' });
  });

  it('still reports links as skipped', () => {
    const withLinks = parse(
      'openapi: 3.1.0\ninfo: { title: T, version: "1" }\npaths:\n  /a:\n    get:\n      links: { x: {} }\n      responses: {}\n',
    );
    expect(withLinks.skipped.map((entry) => entry.kind)).toContain('link');
  });
});
