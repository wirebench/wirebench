/**
 * Walking a path of JSON object keys down to the message whose fields belong there.
 *
 * The walk is what turns `jsonCompletionContextAt`'s path into a schema answer, and the cases that
 * matter are the ones where a JSON level and a protobuf level do not line up: a repeated field,
 * whose items are the field's own type, and a map, whose entries the user names.
 */
import { describe, expect, it } from 'vitest';
import { describeMessageAt } from '../../../src/grpc/proto/describe.js';
import { loadProtoSet } from '../../../src/grpc/proto/load.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const greeter = () => loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] });

/** The field names of the message at `path`, or `undefined` when the path resolves to nothing. */
function fieldsAt(path: readonly string[], type = 'wirebench.greet.HelloRequest'): string[] | undefined {
  return describeMessageAt(greeter(), type, path)?.fields.map((field) => field.name);
}

describe('describeMessageAt', () => {
  it('answers the root message for an empty path', () => {
    expect(fieldsAt([])).toContain('big_number');
  });

  it('descends into a message field', () => {
    expect(fieldsAt(['address'])).toEqual(['city', 'country']);
  });

  it('accepts a field written in its JSON name as well as its declared one', () => {
    expect(describeMessageAt(greeter(), 'wirebench.greet.HelloReply', ['echo'])?.fullName).toBe(
      'wirebench.greet.HelloRequest',
    );
    expect(fieldsAt(['big_number'])).toBeUndefined();
    expect(fieldsAt(['bigNumber'])).toBeUndefined();
  });

  it('consumes the user’s own key when the level is a map', () => {
    // `map<string, HelloRequest>` has no such field here, so `metadata` on the reply is the shape:
    // the entry key is a segment, and a scalar value type ends the walk.
    expect(describeMessageAt(greeter(), 'wirebench.greet.HelloReply', ['metadata', 'x-trace'])).toBeUndefined();
  });

  it('stops on a map itself, whose keys are the user’s to name', () => {
    expect(fieldsAt(['counts'])).toBeUndefined();
  });

  it('stops on a scalar, an enum and a field the message does not have', () => {
    expect(fieldsAt(['name'])).toBeUndefined();
    expect(fieldsAt(['mood'])).toBeUndefined();
    expect(fieldsAt(['nope'])).toBeUndefined();
  });

  it('refuses a well-known type, whose JSON is its mapping rather than its fields', () => {
    // A Timestamp is an RFC 3339 string, so offering `seconds` and `nanos` would offer a document
    // the codec will not read back.
    expect(fieldsAt(['at'])).toBeUndefined();
    expect(fieldsAt(['label'])).toBeUndefined();
    expect(fieldsAt(['payload'])).toBeUndefined();
  });

  it('follows a chain through more than one message', () => {
    expect(describeMessageAt(greeter(), 'wirebench.greet.HelloReply', ['echo', 'address'])?.fields).toHaveLength(2);
  });
});
