import { describe, expect, it } from 'vitest';
import { nameOf } from '../../src/renderer/features/console/log-name.js';
import {
  logExchange,
  makeExchange,
  makeFailure,
  makeGrpcExchange,
  makeRestExchange,
  makeWsHandshakeEntry,
} from '../mocks/exchange-fixtures.js';

const sources = {
  requests: { 'req-1': { name: 'Add numbers' } },
  restRequests: { 'rest-1': { name: 'List pets' } },
  grpcRequests: { 'grpc-1': { service: 'pets.v1.PetService', method: 'GetPet' } },
  wsRequests: { 'ws-1': { name: 'Lobby' } },
};

describe('nameOf', () => {
  it('resolves each protocol from its record', () => {
    expect(nameOf(logExchange(makeExchange(), 'req-1'), sources)).toBe('Add numbers');
    expect(nameOf(logExchange(makeRestExchange(), 'rest-1'), sources)).toBe('List pets');
    expect(nameOf(logExchange(makeGrpcExchange(), 'grpc-1'), sources)).toBe('PetService/GetPet');
    expect(nameOf(makeWsHandshakeEntry({}, 'ws-1'), sources)).toBe('Lobby');
  });

  it('a REST row with an event stream appends its event count', () => {
    const streamed = {
      ...makeRestExchange(),
      stream: {
        rows: [],
        counts: { events: 3, comments: 0, retries: 0, bytes: 0 },
        lastEventId: '',
        endedBy: 'server' as const,
        droppedRows: 0,
        truncated: false,
        omittedRows: 0,
      },
    };
    expect(nameOf(logExchange(streamed, 'rest-1'), sources)).toBe('List pets · 3 events');

    const one = { ...streamed, stream: { ...streamed.stream, counts: { ...streamed.stream.counts, events: 1 } } };
    expect(nameOf(logExchange(one, 'rest-1'), sources)).toBe('List pets · 1 event');
  });

  it('an event stream still gets its event count on the URL-path fallback', () => {
    const streamed = {
      ...makeRestExchange(),
      stream: {
        rows: [],
        counts: { events: 2, comments: 0, retries: 0, bytes: 0 },
        lastEventId: '',
        endedBy: 'server' as const,
        droppedRows: 0,
        truncated: false,
        omittedRows: 0,
      },
    };
    expect(nameOf(logExchange(streamed, 'gone'), sources)).toBe(`${new URL(streamed.url).pathname} · 2 events`);
  });

  it('falls back to the URL path for an unknown or missing request', () => {
    const failure = makeFailure({ request: { url: 'https://h/api/pets?x=1', method: 'GET', headers: {} } });
    const adHoc = { ...failure };
    delete adHoc.requestId;
    expect(nameOf({ kind: 'failure', failure: adHoc }, sources)).toBe('/api/pets');
    expect(nameOf({ kind: 'failure', failure: { ...failure, requestId: 'gone' } }, sources)).toBe('/api/pets');
    expect(
      nameOf({ kind: 'failure', failure: { ...adHoc, request: { ...adHoc.request, url: 'not a url' } } }, sources),
    ).toBe('not a url');
  });
});
