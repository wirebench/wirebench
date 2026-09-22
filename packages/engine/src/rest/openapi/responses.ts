/**
 * Choosing the declared response a received one is checked against.
 *
 * Status first: the exact code, then its range (`4XX`, any case), then `default`. Then the media type,
 * parameters ignored: the exact type, then `application/json` for a `+json` suffix, then
 * `application/*`, then `*\/*`. Pure, so the worker and the tests share it.
 */
import type { OpenApiResponse, OpenApiResponses } from './model.js';

export type ResponseSelection =
  | { readonly kind: 'schema'; readonly responseKey: string; readonly mediaType: string; readonly schema: unknown }
  | { readonly kind: 'no-body'; readonly responseKey: string }
  | { readonly kind: 'no-schema'; readonly responseKey: string }
  | { readonly kind: 'unmatched' };

function own(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function findStatus(responses: OpenApiResponses, status: number): [string, OpenApiResponse] | undefined {
  const exact = String(status);
  if (own(responses, exact)) {
    return [exact, responses[exact] as OpenApiResponse];
  }
  const range = `${Math.floor(status / 100)}xx`;
  for (const key of Object.keys(responses)) {
    if (key.toLowerCase() === range) {
      return [key, responses[key] as OpenApiResponse];
    }
  }
  if (own(responses, 'default')) {
    return ['default', responses['default'] as OpenApiResponse];
  }
  return undefined;
}

function essence(mediaType: string): string {
  return (mediaType.split(';')[0] ?? '').trim().toLowerCase();
}

export function selectResponse(
  responses: OpenApiResponses,
  status: number,
  contentType: string | undefined,
): ResponseSelection {
  const found = findStatus(responses, status);
  if (found === undefined) {
    return { kind: 'unmatched' };
  }
  const [responseKey, response] = found;
  const content = response.content;
  if (content === undefined || Object.keys(content).length === 0) {
    return { kind: 'no-body', responseKey };
  }
  const declared = new Map<string, string>();
  for (const key of Object.keys(content)) {
    const normal = essence(key);
    if (!declared.has(normal)) {
      declared.set(normal, key);
    }
  }
  const received = contentType === undefined ? '' : essence(contentType);
  const candidates = [
    received,
    received.endsWith('+json') ? 'application/json' : '',
    received.startsWith('application/') ? 'application/*' : '',
    '*/*',
  ];
  for (const candidate of candidates) {
    const key = candidate === '' ? undefined : declared.get(candidate);
    if (key === undefined) {
      continue;
    }
    const schema = content[key]?.schema;
    if (schema === undefined) {
      return { kind: 'no-schema', responseKey };
    }
    return { kind: 'schema', responseKey, mediaType: key, schema };
  }
  return { kind: 'no-schema', responseKey };
}
