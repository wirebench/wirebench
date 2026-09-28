/**
 * The checks on a pre-request script's changes, called directly with forged results: what the
 * sandbox hands back is untrusted, so each rule has to hold without the prelude's help.
 */
import { describe, expect, it } from 'vitest';
import { applyRequestChanges, secretReferencesIn } from '../../../src/script/apply.js';
import type { GrpcRequestSnapshot, RestRequestSnapshot, SoapRequestSnapshot } from '../../../src/script/model.js';

const REST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'GET',
  url: 'https://a.test/x',
  headers: [['A', '${secret:one}']],
  body: { kind: 'none' },
};
const SOAP: SoapRequestSnapshot = {
  protocol: 'soap',
  endpoint: 'https://s.test/ws',
  soapAction: '',
  headers: [],
  envelope: '<e>${secret:two}</e>',
};
const GRPC: GrpcRequestSnapshot = {
  protocol: 'grpc',
  target: 'g.test:443',
  method: 'a.B/C',
  metadata: [],
  message: { key: '${secret:three}' },
};

describe('applyRequestChanges', () => {
  it('accepts an unchanged request', () => {
    for (const request of [REST, SOAP, GRPC]) {
      expect(applyRequestChanges(request, request)).toEqual({ ok: true, request });
    }
  });

  it('refuses a shape it cannot read, or another protocol', () => {
    expect(applyRequestChanges(REST, { protocol: 'rest' })).toMatchObject({
      ok: false,
      error: { code: 'script-error' },
    });
    expect(applyRequestChanges(REST, SOAP)).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect(applyRequestChanges(REST, undefined)).toMatchObject({ ok: false });
  });

  it('refuses a method that is not a token, and a URL with a line break', () => {
    expect(applyRequestChanges(REST, { ...REST, method: 'GET /x HTTP/1.1' })).toMatchObject({
      ok: false,
      error: { code: 'script-value-invalid' },
    });
    expect(applyRequestChanges(REST, { ...REST, url: 'https://a.test/x\r\nHost: b' })).toMatchObject({
      ok: false,
      error: { code: 'script-value-invalid' },
    });
  });

  it('keeps a relative destination exactly as it was', () => {
    const relative = { ...REST, url: '/x' };
    expect(applyRequestChanges(relative, { ...relative, url: '/y' })).toMatchObject({
      ok: false,
      error: { code: 'script-origin-change' },
    });
  });

  it('refuses a changed body a script cannot edit', () => {
    const form: RestRequestSnapshot = { ...REST, body: { kind: 'other', description: 'multipart' } };
    expect(applyRequestChanges(form, { ...form, body: { kind: 'none' } })).toMatchObject({
      ok: false,
      error: { code: 'script-error' },
    });
  });

  it('refuses a SOAP header or gRPC metadata with a line break, and a changed gRPC method', () => {
    expect(applyRequestChanges(SOAP, { ...SOAP, headers: [['X\n', 'v']] })).toMatchObject({
      error: { code: 'script-value-invalid' },
    });
    expect(applyRequestChanges(GRPC, { ...GRPC, metadata: [['k', 'v\0']] })).toMatchObject({
      error: { code: 'script-value-invalid' },
    });
    expect(applyRequestChanges(GRPC, { ...GRPC, method: 'a.B/D' })).toMatchObject({ error: { code: 'script-error' } });
    expect(applyRequestChanges(SOAP, { ...SOAP, endpoint: 'http://s.test/ws' })).toMatchObject({
      error: { code: 'script-origin-change' },
    });
  });

  it('refuses a secret reference the request did not already hold', () => {
    expect(applyRequestChanges(SOAP, { ...SOAP, envelope: '<e>${secret:two}${secret:four}</e>' })).toMatchObject({
      error: { code: 'script-secret-denied', message: expect.stringContaining('four') as unknown },
    });
    expect(applyRequestChanges(GRPC, { ...GRPC, metadata: [['k', '${secret:three}']] })).toMatchObject({ ok: true });
  });
});

describe('secretReferencesIn', () => {
  it('finds references in every part of each protocol', () => {
    expect([...secretReferencesIn(REST)]).toEqual(['one']);
    expect([...secretReferencesIn({ ...REST, body: { kind: 'text', text: '${secret:b}', language: 'json' } })]).toEqual(
      ['one', 'b'],
    );
    expect([...secretReferencesIn(SOAP)]).toEqual(['two']);
    expect([...secretReferencesIn(GRPC)]).toEqual(['three']);
  });
});
