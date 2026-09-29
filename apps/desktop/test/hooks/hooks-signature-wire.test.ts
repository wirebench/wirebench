import { describe, expect, it } from 'vitest';
import { captureSummarySchema, catchUrlSchema, CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import type { Capture } from '@wirebench/engine';
import { toCaptureView } from '../../src/main/hooks/hooks-service.js';
import {
  captureSummaryWireSchema,
  catchUrlWireSchema,
  hooksUpdateRequestWireSchema,
} from '../../src/shared/wire-types.js';

const HOOK = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  name: 'Signed',
  url: 'https://wirebench.test/hooks/3ZC5Q0V7R3T9XK2M4N6P8QAB7Y',
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-29T10:00:00.000Z',
  signature: {
    scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
    secret: { set: true, hint: 'i789' },
  },
  rejectUnverified: true,
  signatureAvailable: true,
};

describe('catch URL signature fields cross the bridge (§4)', () => {
  it('keeps what the engine parsed', () => {
    const parsed = catchUrlSchema.parse(HOOK);
    expect(catchUrlWireSchema.parse(parsed)).toEqual(parsed);
    expect(
      hooksUpdateRequestWireSchema.parse({ url: 'u', workspaceId: 'w', hookId: 'h', signature: null }),
    ).toMatchObject({
      signature: null,
    });
  });

  it('passes a verdict and a rejection through to the viewer', () => {
    const summary = captureSummarySchema.parse({
      id: '01J8ZC5Q0V7R3T9XK2M4N6P8QC',
      receivedAt: '2026-09-29T10:00:01.000Z',
      method: 'POST',
      subpath: '',
      bodySize: 2,
      truncated: false,
      sourceIp: '203.0.113.9',
      signature: { verdict: 'failed', reason: 'mismatch' },
      rejected: true,
    });
    expect(captureSummaryWireSchema.parse(summary)).toEqual(summary);
    const capture: Capture = { ...summary, query: '', headers: [], body: Buffer.from('{}').toString('base64') };
    expect(toCaptureView(capture)).toMatchObject({
      signature: { verdict: 'failed', reason: 'mismatch' },
      rejected: true,
    });
    const { signature, rejected, ...unchecked } = capture;
    expect({ signature, rejected }).toEqual({ signature: { verdict: 'failed', reason: 'mismatch' }, rejected: true });
    const view = toCaptureView(unchecked);
    expect(view).not.toHaveProperty('signature');
    expect(view).not.toHaveProperty('rejected');
  });
});
