import { describe, expect, it } from 'vitest';
import { droppedHeader, saveAsWebhookDraft } from '../../src/renderer/features/webhook-items/save-as-webhook.js';
import type { CaptureViewWire } from '../../src/shared/wire-types.js';

function capture(patch: Partial<CaptureViewWire> = {}): CaptureViewWire {
  return {
    id: 'c1',
    receivedAt: '2026-09-28T10:42:00.000Z',
    method: 'POST',
    subpath: '/payments',
    bodySize: 40,
    truncated: false,
    sourceIp: '203.0.113.9',
    query: 'a=1',
    headers: [
      ['Host', 'srv.test'],
      ['Content-Type', 'application/json'],
      ['Content-Length', '40'],
      ['X-Forwarded-For', '1.2.3.4'],
      ['Provider-Signature', 't=1,v1=abc'],
      ['X-Hub-Signature-256', 'sha256=x'],
      ['X-Event-Id', 'evt_1'],
      ['Proxy-Authorization', 'x'],
      ['X-Request-Id', 'r'],
    ],
    bodyBase64: '',
    contentType: 'application/json',
    text: '{"type":"payment.succeeded","id":"evt_1"}',
    language: 'json',
    ...patch,
  };
}

describe('droppedHeader', () => {
  it('drops transport, proxy, forwarding and signature headers', () => {
    for (const name of [
      'Host',
      'content-length',
      'Connection',
      'Transfer-Encoding',
      'Keep-Alive',
      'Upgrade',
      'TE',
      'Trailer',
      'Forwarded',
      'X-Request-Id',
      'Proxy-Authorization',
      'X-Forwarded-Proto',
      'Provider-Signature',
    ]) {
      expect(droppedHeader(name)).toBe(true);
    }
    expect(droppedHeader('Content-Type')).toBe(false);
    expect(droppedHeader('X-Event-Id')).toBe(false);
  });
});

describe('saveAsWebhookDraft', () => {
  it('copies method, sub-path, query, kept headers and body', () => {
    const result = saveAsWebhookDraft(capture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBe('payment.succeeded');
    expect(result.draft.method).toBe('POST');
    expect(result.draft.url).toBe('/payments?a=1');
    expect(result.draft.headers?.map((h) => h.name)).toEqual(['Content-Type', 'X-Event-Id']);
    expect(result.draft.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{"type":"payment.succeeded","id":"evt_1"}',
    });
  });

  it('names by method and path without a type field, and reads form bodies as fields', () => {
    const result = saveAsWebhookDraft(
      capture({
        contentType: 'application/x-www-form-urlencoded',
        language: 'text',
        text: 'a=1&b=two%20words',
        query: '',
      }),
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.name).toBe('POST /payments');
    expect(result.draft.url).toBe('/payments');
    expect(result.draft.body).toEqual({
      kind: 'form',
      fields: [
        { name: 'a', value: '1', enabled: true },
        { name: 'b', value: 'two words', enabled: true },
      ],
    });
  });

  it('keeps XML and plain text as raw bodies of their language, and an empty body as none', () => {
    const xml = saveAsWebhookDraft(capture({ contentType: 'application/xml', language: 'xml', text: '<a/>' }));
    expect(xml.ok && xml.draft.body).toEqual({ kind: 'raw', language: 'xml', text: '<a/>' });
    const text = saveAsWebhookDraft(capture({ contentType: 'text/plain', language: 'text', text: 'hi' }));
    expect(text.ok && text.draft.body).toEqual({ kind: 'raw', language: 'text', text: 'hi' });
    const empty = saveAsWebhookDraft(capture({ text: '', contentType: null, language: 'text' }));
    expect(empty.ok && empty.draft.body).toEqual({ kind: 'none' });
  });

  it('refuses a truncated or binary capture', () => {
    expect(saveAsWebhookDraft(capture({ truncated: true }))).toMatchObject({
      ok: false,
      code: 'webhook-save-truncated',
    });
    expect(saveAsWebhookDraft(capture({ language: 'binary' }))).toMatchObject({
      ok: false,
      code: 'webhook-save-binary',
    });
    expect(saveAsWebhookDraft(capture({ language: 'image' }))).toMatchObject({
      ok: false,
      code: 'webhook-save-binary',
    });
  });
});
