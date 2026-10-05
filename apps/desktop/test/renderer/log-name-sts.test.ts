import { describe, expect, it } from 'vitest';
import { nameOf } from '../../src/renderer/features/console/log-name.js';
import { isStsRow, rowActions } from '../../src/renderer/features/console/log-row-actions.js';
import { logExchange, makeExchange } from '../mocks/exchange-fixtures.js';

const sources = {
  requests: { r1: { name: 'GetQuote' } },
  restRequests: {},
  grpcRequests: {},
  wsRequests: {},
};

/** A token-service row as main emits it: no parsed response, marked `sts`. */
function stsRow(requestId?: string, causedBy: string | undefined = 'send-1') {
  const exchange = makeExchange({ sendId: 'send-1:sts:1', auxiliary: 'sts' });
  delete exchange.response;
  return logExchange(causedBy === undefined ? exchange : { ...exchange, causedBy }, requestId);
}

describe('an STS row in the HTTP Log', () => {
  it('is named for the request it was made for, with the STS prefix', () => {
    expect(nameOf(stsRow('r1'), sources)).toBe('STS · GetQuote');
    expect(nameOf(logExchange(makeExchange(), 'r1'), sources)).toBe('GetQuote');
  });

  it('a Fetch now row, with no request, is named by its URL path and never empty', () => {
    const name = nameOf(stsRow(undefined, undefined), sources);
    expect(name).toBe('STS · /calc.asmx');
  });

  it('cannot be resent, since main holds no copy of it; the rest of its menu still works', () => {
    const actions = rowActions(stsRow('r1'), { has: () => true, unaryGrpc: () => true });
    expect(isStsRow(stsRow('r1'))).toBe(true);
    expect(actions.find((a) => a.id === 'resend')).toMatchObject({ enabled: false });
    expect(actions.find((a) => a.id === 'copy-response-body')).toMatchObject({ enabled: true });
    expect(actions.find((a) => a.id === 'open-request')).toMatchObject({ enabled: true });
  });
});
