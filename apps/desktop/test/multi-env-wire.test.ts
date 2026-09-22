// @vitest-environment node
/**
 * The `request.sendToEnvironments` wire: 2–10 environment ids, no renderer-supplied endpoint,
 * and a per-environment result that is either a SOAP or REST summary or an error.
 */
import { describe, expect, it } from 'vitest';
import { channels } from '../src/shared/ipc.js';
import {
  envSendResultSchema,
  requestSendToEnvironmentsRequestSchema,
  requestSendToEnvironmentsResponseSchema,
} from '../src/shared/wire-types.js';

const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => `env-${index}`);

const http = {
  status: 200,
  statusText: 'OK',
  headers: {},
  rawHeaders: [],
  bodyBase64: '',
  rawBodyBase64: '',
  rawRequestBase64: '',
  rawResponseBase64: '',
  truncated: false,
  timings: { startedAt: '2026-09-22T00:00:00.000Z', totalMs: 5 },
  redirects: [],
  request: { url: 'https://dev.example/pets', method: 'GET', headers: {} },
};

describe('request.sendToEnvironments wire', () => {
  it('accepts two to ten environment ids', () => {
    for (const count of [2, 10]) {
      const parsed = requestSendToEnvironmentsRequestSchema.safeParse({
        batchId: 'batch-1',
        requestId: 'req-1',
        environmentIds: ids(count),
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects one environment id and eleven', () => {
    for (const count of [1, 11]) {
      const parsed = requestSendToEnvironmentsRequestSchema.safeParse({
        batchId: 'batch-1',
        requestId: 'req-1',
        environmentIds: ids(count),
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('refuses an endpoint from the renderer: main resolves it per environment', () => {
    const parsed = requestSendToEnvironmentsRequestSchema.safeParse({
      batchId: 'batch-1',
      requestId: 'req-1',
      environmentIds: ids(2),
      endpoint: 'https://elsewhere.example',
    });
    expect(parsed.success).toBe(false);
  });

  it('carries the SOAP editor state and the REST draft', () => {
    const parsed = requestSendToEnvironmentsRequestSchema.parse({
      batchId: 'batch-1',
      requestId: 'req-1',
      environmentIds: ids(2),
      soap: { envelopeXml: '<Envelope/>', headers: { 'X-Trace': '1' } },
      restDraft: { url: '/pets' },
    });
    expect(parsed.soap?.envelopeXml).toBe('<Envelope/>');
    expect(parsed.restDraft?.url).toBe('/pets');
  });

  it('parses an ok SOAP result, an ok REST result and an error', () => {
    const soap = {
      outcome: 'ok',
      environmentId: 'env-0',
      environmentName: 'dev',
      kind: 'soap',
      soap: { sendId: 'batch-1:env-0', durationMs: 5, http, problems: [] },
    };
    const rest = {
      outcome: 'ok',
      environmentId: 'env-1',
      environmentName: 'test',
      kind: 'rest',
      rest: {
        sendId: 'batch-1:env-1',
        durationMs: 5,
        http,
        url: 'https://test.example/pets',
        method: 'GET',
        text: '{}',
        language: 'json',
        cookies: [],
        methodChanged: false,
        problems: [],
      },
    };
    const error = {
      outcome: 'error',
      environmentId: 'env-2',
      environmentName: 'prod',
      code: 'rest-unresolved-properties',
      message: 'tenant did not resolve',
    };
    expect(envSendResultSchema.parse(soap)).toMatchObject({ outcome: 'ok', kind: 'soap' });
    expect(envSendResultSchema.parse(rest)).toMatchObject({ outcome: 'ok', kind: 'rest' });
    expect(envSendResultSchema.parse(error)).toMatchObject({ outcome: 'error', code: 'rest-unresolved-properties' });
    expect(requestSendToEnvironmentsResponseSchema.parse({ results: [soap, rest, error] }).results).toHaveLength(3);
    expect(envSendResultSchema.safeParse({ ...error, outcome: 'maybe' }).success).toBe(false);
  });

  it('is registered as request.sendToEnvironments', () => {
    expect(channels.request.sendToEnvironments.name).toBe('request.sendToEnvironments');
  });
});
