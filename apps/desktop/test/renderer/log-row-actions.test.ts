import { describe, expect, it } from 'vitest';
import {
  headersText,
  responseBodyText,
  rowActions,
  type RequestLookup,
} from '../../src/renderer/features/console/log-row-actions.js';
import { b64, logExchange, makeFailure, makeGrpcExchange, makeRestExchange } from '../mocks/exchange-fixtures.js';

const known: RequestLookup = { has: () => true, unaryGrpc: () => true };
const gone: RequestLookup = { has: () => false, unaryGrpc: () => true };
/** A REST exchange that sent one header, so copying request headers has something to copy. */
function restWithHeaders() {
  const exchange = makeRestExchange();
  return {
    ...exchange,
    http: { ...exchange.http, request: { ...exchange.http.request, headers: { Accept: 'application/json' } } },
  };
}
const enabled = (actions: ReturnType<typeof rowActions>) => actions.filter((a) => a.enabled).map((a) => a.id);

describe('rowActions', () => {
  it('an exchange from a live request enables everything', () => {
    expect(enabled(rowActions(logExchange(restWithHeaders(), 'rest-1'), known))).toEqual([
      'curl-posix',
      'curl-powershell',
      'copy-url',
      'copy-request-headers',
      'copy-response-headers',
      'copy-response-body',
      'resend',
      'open-request',
    ]);
  });

  it('a failure has no response actions; resend explains what it sends', () => {
    const actions = rowActions({ kind: 'failure', failure: makeFailure({ requestId: 'rest-1' }) }, known);
    expect(actions.find((a) => a.id === 'copy-response-body')).toMatchObject({ enabled: false, reason: 'No response' });
    expect(actions.find((a) => a.id === 'resend')).toMatchObject({
      enabled: true,
      hint: 'Sends the saved request as it is now',
    });
  });

  it('a prepare failure cannot be resent', () => {
    const actions = rowActions(
      { kind: 'failure', failure: makeFailure({ requestId: 'rest-1', stage: 'prepare' }) },
      known,
    );
    expect(actions.find((a) => a.id === 'resend')).toMatchObject({ enabled: false, reason: 'Never sent' });
  });

  it('a gone or missing request disables resend and open', () => {
    const gonePair = rowActions(logExchange(makeRestExchange(), 'rest-1'), gone);
    expect(gonePair.find((a) => a.id === 'open-request')).toMatchObject({
      enabled: false,
      reason: 'The request no longer exists',
    });
    const adHoc = { ...makeFailure() };
    delete adHoc.requestId;
    expect(rowActions({ kind: 'failure', failure: adHoc }, known).find((a) => a.id === 'resend')).toMatchObject({
      enabled: false,
      reason: 'Not from a saved request',
    });
  });

  it('a streaming gRPC call resends from the editor', () => {
    const streaming: RequestLookup = { has: () => true, unaryGrpc: () => false };
    const actions = rowActions(logExchange(makeGrpcExchange(), 'grpc-1'), streaming);
    expect(actions.find((a) => a.id === 'resend')).toMatchObject({
      enabled: false,
      reason: 'Streaming calls resend from the editor',
    });
  });

  it('no request headers disables copying them', () => {
    const actions = rowActions(logExchange(restWithHeaders(), 'rest-1'), known);
    expect(actions.find((a) => a.id === 'copy-request-headers')?.enabled).toBe(true);
    const bare = makeFailure({ request: { url: 'http://h/', method: 'GET', headers: {} } });
    expect(
      rowActions({ kind: 'failure', failure: bare }, known).find((a) => a.id === 'copy-request-headers')?.enabled,
    ).toBe(false);
  });
});

describe('copy text', () => {
  it('headersText writes one "Name: value" line per header', () => {
    expect(headersText({ Accept: '*/*', 'X-A': '1' })).toBe('Accept: */*\nX-A: 1');
  });

  it('responseBodyText decodes the body; undefined for a failure', () => {
    const exchange = makeRestExchange();
    const entry = logExchange({ ...exchange, http: { ...exchange.http, bodyBase64: b64('{"ok":true}') } });
    expect(responseBodyText(entry)).toBe('{"ok":true}');
    expect(responseBodyText({ kind: 'failure', failure: makeFailure() })).toBeUndefined();
  });
});
