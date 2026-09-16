import { describe, expect, it } from 'vitest';
import { ProtoError } from '../../../src/errors.js';
import { describeMessage, describeMethod, describeServices, lookupMethod } from '../../../src/grpc/proto/describe.js';
import { loadProtoSet } from '../../../src/grpc/proto/load.js';
import { sampleMessage, sampleMessageText } from '../../../src/grpc/proto/sample.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const greeter = () => loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] });

describe('loadProtoSet', () => {
  it('follows imports through the source map and the bundled well-known files', () => {
    const set = greeter();
    expect(set.roots).toEqual(['greeter.proto']);
    expect(set.files).toContain('wirebench/common/address.proto');
    expect(set.files).toContain('google/protobuf/timestamp.proto');
    expect(set.files[0]).toBe('greeter.proto');
  });

  it('resolves an import relative to the importing file, or by unique suffix, when the verbatim path is absent', () => {
    const sources = new Map([
      ['protos/a.proto', 'syntax = "proto3"; package a; import "b.proto"; message A { b.B b = 1; }'],
      ['protos/b.proto', 'syntax = "proto3"; package b; message B { string x = 1; }'],
      ['deep/nested/c.proto', 'syntax = "proto3"; package c; import "nested/d.proto"; message C { d.D d = 1; }'],
      ['deep/nested/d.proto', 'syntax = "proto3"; package d; message D { string x = 1; }'],
    ]);
    const set = loadProtoSet(sources, { roots: ['protos/a.proto', 'deep/nested/c.proto'] });
    expect(set.files).toEqual(['protos/a.proto', 'protos/b.proto', 'deep/nested/c.proto', 'deep/nested/d.proto']);
  });

  it('loads every source when no roots are given, and refuses an empty set', () => {
    expect(loadProtoSet(readProtoFixture('no-package')).files).toEqual(['plain.proto']);
    expect(() => loadProtoSet(new Map())).toThrow(ProtoError);
  });

  it('names the file and line of a parse error', () => {
    try {
      loadProtoSet(readProtoFixture('broken'));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtoError);
      expect((error as ProtoError).code).toBe('proto-parse');
      expect((error as ProtoError).details).toMatchObject({ file: 'broken.proto', line: 6 });
      expect((error as ProtoError).message).toContain('broken.proto');
    }
  });

  it('names the importing file when an import is missing', () => {
    const sources = new Map([['a.proto', 'syntax = "proto3"; import "gone.proto"; message A {}']]);
    try {
      loadProtoSet(sources);
      expect.unreachable();
    } catch (error) {
      expect((error as ProtoError).code).toBe('proto-import-missing');
      expect((error as ProtoError).details).toEqual({ file: 'gone.proto', importedBy: 'a.proto' });
    }
  });

  it('reports a type reference that resolves to nothing', () => {
    const sources = new Map([['a.proto', 'syntax = "proto3"; message A { Nope n = 1; }']]);
    expect(() => loadProtoSet(sources)).toThrow(/Nope/);
    try {
      loadProtoSet(sources);
    } catch (error) {
      expect((error as ProtoError).code).toBe('proto-unresolved');
    }
  });
});

describe('describeServices', () => {
  it('lists services with their package, comments and every streaming shape', () => {
    const [service] = describeServices(greeter());
    expect(service).toMatchObject({ name: 'Greeter', fullName: 'wirebench.greet.Greeter', package: 'wirebench.greet' });
    expect(service?.comment).toBe('Greets people, in every streaming shape.');
    expect(service?.methods.map((m) => [m.name, m.kind])).toEqual([
      ['SayHello', 'unary'],
      ['LotsOfReplies', 'server-streaming'],
      ['LotsOfGreetings', 'client-streaming'],
      ['Chat', 'bidi-streaming'],
      ['Fail', 'unary'],
      ['Slow', 'unary'],
      ['Deprecated', 'unary'],
    ]);
    const sayHello = service?.methods[0];
    expect(sayHello).toMatchObject({
      requestType: 'wirebench.greet.HelloRequest',
      responseType: 'wirebench.greet.HelloReply',
      comment: 'Says hello once.',
    });
    expect(service?.methods.at(-1)?.deprecated).toBe(true);
    expect(service?.methods[4]?.responseType).toBe('google.protobuf.Empty');
  });

  it('handles a service outside any package', () => {
    const [service] = describeServices(loadProtoSet(readProtoFixture('no-package')));
    expect(service).toMatchObject({ name: 'Pinger', fullName: 'Pinger', package: '' });
  });

  it('looks a method up by service and name, refusing unknown ones by code', () => {
    const set = greeter();
    expect(lookupMethod(set, 'wirebench.greet.Greeter', 'SayHello').name).toBe('SayHello');
    expect(describeMethod(set, '.wirebench.greet.Greeter', 'Chat').kind).toBe('bidi-streaming');
    for (const [service, method] of [
      ['wirebench.greet.Nope', 'SayHello'],
      ['wirebench.greet.Greeter', 'Nope'],
    ] as const) {
      try {
        lookupMethod(set, service, method);
        expect.unreachable();
      } catch (error) {
        expect((error as ProtoError).code).toBe('proto-method-unknown');
      }
    }
  });
});

describe('describeMessage', () => {
  it('flattens fields with their kind, cardinality, oneof and enum values', () => {
    const message = describeMessage(greeter(), 'wirebench.greet.HelloRequest');
    const byName = Object.fromEntries(message.fields.map((field) => [field.name, field]));
    expect(byName['name']).toMatchObject({
      id: 1,
      type: 'string',
      valueKind: 'scalar',
      repeated: false,
      optional: false,
      comment: 'Who to greet.',
    });
    expect(byName['tags']).toMatchObject({ valueKind: 'scalar', repeated: true });
    expect(byName['counts']).toMatchObject({ valueKind: 'map', mapKeyType: 'string', type: 'int32' });
    expect(byName['mood']).toMatchObject({
      valueKind: 'enum',
      type: 'wirebench.greet.Mood',
      enumValues: ['MOOD_UNSPECIFIED', 'CHEERFUL', 'FORMAL'],
    });
    expect(byName['address']).toMatchObject({ valueKind: 'message', type: 'wirebench.common.Address' });
    expect(byName['note']).toMatchObject({ oneof: 'extra' });
    expect(byName['nickname']).toMatchObject({ optional: true });
    expect(byName['nickname']?.oneof).toBeUndefined();
    expect(message.oneofs).toEqual(['extra']);
  });

  it('refuses an unknown type by code', () => {
    try {
      describeMessage(greeter(), 'wirebench.greet.Nope');
      expect.unreachable();
    } catch (error) {
      expect((error as ProtoError).code).toBe('proto-type-unknown');
    }
  });
});

describe('sampleMessage', () => {
  it('gives every field a zero-ish value of the right JSON shape, one oneof member, and well-known forms', () => {
    const sample = sampleMessage(greeter(), 'wirebench.greet.HelloRequest') as Record<string, unknown>;
    expect(sample).toEqual({
      name: '',
      big_number: '0',
      tags: [''],
      counts: { key: 0 },
      mood: 'MOOD_UNSPECIFIED',
      at: '1970-01-01T00:00:00Z',
      address: { city: '', country: '' },
      note: '',
      blob: '',
      nickname: '',
      patience: '0s',
      details: {},
      label: '',
      payload: { '@type': '' },
      mask: '',
    });
    expect(sampleMessageText(greeter(), 'google.protobuf.Empty')).toBe('{}\n');
  });

  it('stops recursing at the depth cap', () => {
    const set = loadProtoSet(
      new Map([['t.proto', 'syntax = "proto3"; message Node { Node child = 1; string v = 2; }']]),
    );
    const sample = sampleMessage(set, 'Node', { maxDepth: 1 }) as { child: { child: unknown } };
    expect(sample.child.child).toEqual({});
  });
});
