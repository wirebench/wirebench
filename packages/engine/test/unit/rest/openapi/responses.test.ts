/**
 * Which declared response a received one is checked against: status first (exact, range, default),
 * then media type (exact, `+json`, `application/*`, `*\/*`), media-type parameters ignored.
 */
import { describe, expect, it } from 'vitest';
import { selectResponse } from '../../../../src/rest/openapi/responses.js';
import type { OpenApiResponses } from '../../../../src/rest/openapi/model.js';

const s = (name: string): { title: string } => ({ title: name });

describe('selectResponse', () => {
  const responses: OpenApiResponses = {
    '200': { content: { 'application/json': { schema: s('ok') } } },
    '404': { content: { 'application/json': { schema: s('notFound') } } },
    '4XX': { content: { 'application/json': { schema: s('clientError') } } },
    default: { content: { 'application/json': { schema: s('fallback') } } },
    '204': { description: 'nothing' },
    '201': { content: { 'application/json': {} } },
  };

  it('prefers the exact status over the range over default', () => {
    expect(selectResponse(responses, 404, 'application/json')).toEqual({
      kind: 'schema',
      responseKey: '404',
      mediaType: 'application/json',
      schema: s('notFound'),
    });
    expect(selectResponse(responses, 418, 'application/json')).toMatchObject({ responseKey: '4XX' });
    expect(selectResponse(responses, 500, 'application/json')).toMatchObject({ responseKey: 'default' });
  });

  it('matches a lower-case range key', () => {
    expect(
      selectResponse({ '4xx': { content: { 'application/json': { schema: s('x') } } } }, 422, 'application/json'),
    ).toMatchObject({ kind: 'schema', responseKey: '4xx' });
  });

  it('ignores media-type parameters and case', () => {
    expect(selectResponse(responses, 200, 'Application/JSON; charset=utf-8')).toMatchObject({
      kind: 'schema',
      mediaType: 'application/json',
    });
  });

  it('falls back from exact to +json to application/* to */*', () => {
    const r: OpenApiResponses = {
      '200': {
        content: {
          'application/problem+json': { schema: s('exact') },
          'application/json': { schema: s('json') },
          'application/*': { schema: s('app') },
          '*/*': { schema: s('any') },
        },
      },
    };
    expect(selectResponse(r, 200, 'application/problem+json')).toMatchObject({ schema: s('exact') });
    expect(selectResponse(r, 200, 'application/vnd.thing+json')).toMatchObject({ schema: s('json') });
    expect(selectResponse(r, 200, 'application/xml')).toMatchObject({ schema: s('app') });
    expect(selectResponse(r, 200, 'text/plain')).toMatchObject({ mediaType: '*/*', schema: s('any') });
  });

  it('a declared status with no content is no-body', () => {
    expect(selectResponse(responses, 204, undefined)).toEqual({ kind: 'no-body', responseKey: '204' });
  });

  it('a declared status whose media type has no schema, or no matching media type, is no-schema', () => {
    expect(selectResponse(responses, 201, 'application/json')).toEqual({ kind: 'no-schema', responseKey: '201' });
    expect(selectResponse(responses, 200, 'text/html')).toEqual({ kind: 'no-schema', responseKey: '200' });
  });

  it('an undeclared status is unmatched', () => {
    expect(selectResponse({ '200': {} }, 503, 'application/json')).toEqual({ kind: 'unmatched' });
    expect(selectResponse({}, 200, undefined)).toEqual({ kind: 'unmatched' });
  });
});
