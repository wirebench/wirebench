import { describe, expect, it } from 'vitest';
import { ProtoError } from '../../../src/errors.js';
import { decodeMessage, encodeMessage, parseMessageText } from '../../../src/grpc/codec.js';
import { loadProtoSet } from '../../../src/grpc/proto/load.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const set = loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] });
const REQUEST = 'wirebench.greet.HelloRequest';

function roundTrip(json: unknown, type = REQUEST): unknown {
  return decodeMessage(set, type, encodeMessage(set, type, json));
}

describe('gRPC codec', () => {
  it('round-trips scalars, repeated, maps, enums, nested messages, oneofs, bytes and 64-bit integers', () => {
    const json = {
      name: 'Ada',
      big_number: '9007199254740993',
      tags: ['a', 'b'],
      counts: { x: 1, y: 2 },
      mood: 'FORMAL',
      address: { city: 'Paris', country: 'FR' },
      priority: 7,
      blob: Buffer.from('hi').toString('base64'),
      nickname: 'A',
    };
    expect(roundTrip(json)).toEqual(json);
  });

  it('accepts lowerCamelCase JSON names and enum numbers on the way in', () => {
    expect(roundTrip({ bigNumber: '5', mood: 2 })).toEqual({ big_number: '5', mood: 'FORMAL' });
  });

  it('omits fields at their default value on the way out', () => {
    expect(roundTrip({ name: '', tags: [], counts: {}, mood: 'MOOD_UNSPECIFIED' })).toEqual({});
  });

  it('maps the well-known types to and from their JSON forms', () => {
    const json = {
      at: '2024-05-06T07:08:09.500Z',
      patience: '1.250s',
      details: { a: 1, b: 'two', c: [true, null, { d: 2.5 }] },
      label: 'wrapped',
      mask: 'name,address.city',
      payload: { '@type': 'type.googleapis.com/wirebench.common.Address', city: 'Rome' },
    };
    expect(roundTrip(json)).toEqual(json);
    expect(roundTrip({ patience: '-3s' })).toEqual({ patience: '-3s' });
    expect(
      roundTrip({ payload: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'inner' } }),
    ).toEqual({
      payload: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'inner' },
    });
  });

  it('still accepts the field-by-field spelling of a well-known type', () => {
    expect(roundTrip({ at: { seconds: '60', nanos: 0 } })).toEqual({ at: '1970-01-01T00:01:00Z' });
  });

  it('names the offending field for an unknown key or a wrong shape', () => {
    for (const [json, pattern] of [
      [{ nmae: 'x' }, /HelloRequest has no field "nmae"/],
      [{ tags: 'not-an-array' }, /tags: a repeated field must be a JSON array/],
      [{ counts: [] }, /counts: a map field must be a JSON object/],
      [{ name: 42 }, /name: string expected/],
      [{ at: 'yesterday' }, /Timestamp/],
      [{ patience: '5 minutes' }, /Duration/],
      [{ payload: { city: 'x' } }, /@type/],
      [[], /expected a JSON object/],
    ] as const) {
      try {
        encodeMessage(set, REQUEST, json);
        expect.unreachable(`accepted ${JSON.stringify(json)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProtoError);
        expect((error as ProtoError).code).toBe('grpc-message-invalid');
        expect((error as ProtoError).message).toMatch(pattern);
      }
    }
  });

  it('reports bytes that do not decode as the response type', () => {
    try {
      decodeMessage(set, 'wirebench.greet.HelloReply', new Uint8Array([0xff, 0xff, 0xff]));
      expect.unreachable();
    } catch (error) {
      expect((error as ProtoError).code).toBe('grpc-message-malformed');
    }
  });

  it('keeps an Any whose type is not in the set as base64', () => {
    const any = encodeMessage(set, REQUEST, { payload: { type_url: 'type.googleapis.com/x.Unknown', value: 'AQI=' } });
    expect(decodeMessage(set, REQUEST, any)).toEqual({
      payload: { '@type': 'type.googleapis.com/x.Unknown', value: 'AQI=' },
    });
  });

  it('parses body text as one message or a stream of them', () => {
    expect(parseMessageText('{"name":"x"}', false)).toEqual([{ name: 'x' }]);
    expect(parseMessageText('', false)).toEqual([{}]);
    expect(parseMessageText('[{"name":"a"},{"name":"b"}]', true)).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(parseMessageText('{"name":"only"}', true)).toEqual([{ name: 'only' }]);
    expect(() => parseMessageText('[{}]', false)).toThrow(/one message/);
    expect(() => parseMessageText('{oops', false)).toThrow(/not valid JSON/);
  });
});
