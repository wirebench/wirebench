import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSearchCache,
  compileMatcher,
  matchesText,
  SEARCH_BODY_CAP,
} from '../../src/renderer/features/console/log-search.js';
import { matchesFilter } from '../../src/renderer/features/console/log-filter.js';
import { EMPTY_FILTER } from '../../src/renderer/state/exchanges.js';
import { b64, logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

function rest(body: string, headers: Record<string, string> = {}) {
  const exchange = makeRestExchange();
  return logExchange({
    ...exchange,
    http: { ...exchange.http, bodyBase64: b64(body), headers: { ...exchange.http.headers, ...headers } },
  });
}
const plain = (text: string) => compileMatcher({ text, regex: false, matchCase: false });

describe('log search', () => {
  beforeEach(clearSearchCache);

  it('matches a response header value, a body and the name', () => {
    const entry = rest('{"order":"A-7781"}', { 'X-Correlation-Id': 'corr-42' });
    expect(matchesText(entry, plain('corr-42'), undefined)).toBe(true);
    expect(matchesText(entry, plain('a-7781'), undefined)).toBe(true);
    expect(matchesText(entry, plain('Create order'), 'Create order')).toBe(true);
    expect(matchesText(entry, plain('nowhere'), undefined)).toBe(false);
  });

  it('match case and regex', () => {
    const entry = rest('Hello');
    expect(matchesText(entry, compileMatcher({ text: 'hello', regex: false, matchCase: true }), undefined)).toBe(false);
    expect(matchesText(entry, compileMatcher({ text: 'H.l+o', regex: true, matchCase: true }), undefined)).toBe(true);
  });

  it('an invalid regex is flagged and filters nothing', () => {
    expect(compileMatcher({ text: '([', regex: true, matchCase: false }).invalid).toBe(true);
    expect(matchesFilter(rest('x'), { ...EMPTY_FILTER, text: '([', regex: true })).toBe(true);
  });

  it('searches only the first 256 KiB of a body', () => {
    expect(matchesText(rest(`${'a'.repeat(SEARCH_BODY_CAP)}needle`), plain('needle'), undefined)).toBe(false);
  });

  it('searches a failure row by its request headers', () => {
    const failure = {
      kind: 'failure' as const,
      failure: makeFailure({ request: { url: 'http://h/', method: 'GET', headers: { 'X-Tenant': 'blue' } } }),
    };
    expect(matchesText(failure, plain('blue'), undefined)).toBe(true);
  });
});
