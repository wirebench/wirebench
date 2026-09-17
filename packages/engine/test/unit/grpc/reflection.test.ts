/**
 * The pure halves of reflection: the embedded service definition, the partial `FileDescriptorProto`
 * the client reads a file's header with, and the `FileDescriptorSet` it wraps a server's descriptors
 * in before protobufjs resolves them.
 */
import { describe, expect, it } from 'vitest';
import { ProtoError } from '../../../src/errors.js';
import { encodeMessage } from '../../../src/grpc/codec.js';
import { describeServices } from '../../../src/grpc/proto/describe.js';
import { loadProtoSet } from '../../../src/grpc/proto/load.js';
import {
  descriptorHeader,
  encodeFileDescriptorSet,
  protoSetFromDescriptors,
} from '../../../src/grpc/reflection/descriptors.js';
import {
  DESCRIPTOR_HEADER_TYPE,
  REFLECTION_METHOD,
  REFLECTION_VERSIONS,
  descriptorHeaderProtoSet,
  reflectionPackage,
  reflectionProtoSet,
  reflectionProtoSource,
  reflectionServiceName,
} from '../../../src/grpc/reflection/proto.js';
import { reflectionCatalog } from '../../helpers/test-grpc-reflection.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

describe('the embedded reflection definition', () => {
  it.each(REFLECTION_VERSIONS)('declares ServerReflectionInfo as a bidirectional stream in %s', (version) => {
    const set = reflectionProtoSet(version);
    const [service] = describeServices(set);
    expect(service?.fullName).toBe(reflectionServiceName(version));
    expect(service?.package).toBe(reflectionPackage(version));
    const method = service?.methods.find((entry) => entry.name === REFLECTION_METHOD);
    expect(method?.kind).toBe('bidi-streaming');
    expect(method?.requestType).toBe(`${reflectionPackage(version)}.ServerReflectionRequest`);
  });

  it('parses once and hands the same set back', () => {
    expect(reflectionProtoSet('v1')).toBe(reflectionProtoSet('v1'));
    expect(reflectionProtoSet('v1')).not.toBe(reflectionProtoSet('v1alpha'));
  });

  it('differs between the versions only in the package', () => {
    expect(reflectionProtoSource('v1alpha')).toBe(
      reflectionProtoSource('v1').replaceAll('grpc.reflection.v1', 'grpc.reflection.v1alpha'),
    );
  });

  it('keeps the field numbers the wire contract fixes', () => {
    const set = reflectionProtoSet('v1');
    const request = set.root.lookupType('grpc.reflection.v1.ServerReflectionRequest');
    expect(request.fields['list_services']?.id).toBe(7);
    expect(request.fields['file_containing_symbol']?.id).toBe(4);
    expect(request.fields['file_by_filename']?.id).toBe(3);
    const response = set.root.lookupType('grpc.reflection.v1.ServerReflectionResponse');
    expect(response.fields['file_descriptor_response']?.id).toBe(4);
    expect(response.fields['error_response']?.id).toBe(7);
  });
});

describe('descriptorHeader', () => {
  it('reads a file name and its imports, ignoring everything else in the descriptor', () => {
    const catalog = reflectionCatalog(loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] }));
    const file = catalog.files.get('wirebench_greet.proto');
    expect(file).toBeDefined();
    const header = descriptorHeader(file!.bytes);
    expect(header.name).toBe('wirebench_greet.proto');
    expect(header.dependencies).toEqual([...file!.dependencies]);
  });

  it('reads a header written against its own partial schema', () => {
    const bytes = encodeMessage(descriptorHeaderProtoSet(), DESCRIPTOR_HEADER_TYPE, {
      name: 'a.proto',
      dependency: ['b.proto', 'c.proto'],
    });
    expect(descriptorHeader(bytes)).toEqual({ name: 'a.proto', dependencies: ['b.proto', 'c.proto'] });
  });

  it('reports bytes that are not a descriptor', () => {
    expect(() => descriptorHeader(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(
      expect.objectContaining({ code: 'grpc-reflection-descriptor' }),
    );
  });
});

describe('encodeFileDescriptorSet', () => {
  it('writes one length-delimited record per file, byte for byte', () => {
    const encoded = encodeFileDescriptorSet([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect([...encoded]).toEqual([0x0a, 2, 1, 2, 0x0a, 1, 3]);
  });

  it('is empty for no files', () => {
    expect(encodeFileDescriptorSet([]).byteLength).toBe(0);
  });
});

describe('protoSetFromDescriptors', () => {
  const catalog = reflectionCatalog(loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] }));
  const files = new Map([...catalog.files].map(([name, file]) => [name, file.bytes]));

  it('resolves a whole set into the same shape a parsed one has', () => {
    const set = protoSetFromDescriptors({ files, roots: ['wirebench_greet.proto'] });
    expect(describeServices(set).map((service) => service.fullName)).toEqual(['wirebench.greet.Greeter']);
    expect(set.roots).toEqual(['wirebench_greet.proto']);
    // Dependencies first, so a reference resolves as its file is added.
    expect(set.files.indexOf('wirebench_common.proto')).toBeLessThan(set.files.indexOf('wirebench_greet.proto'));
  });

  it('defaults its roots to every file', () => {
    expect(protoSetFromDescriptors({ files }).roots).toEqual(protoSetFromDescriptors({ files }).files);
  });

  it('refuses an empty set', () => {
    expect(() => protoSetFromDescriptors({ files: new Map() })).toThrow(ProtoError);
  });

  it('reports a set whose references do not resolve', () => {
    const partial = new Map([['wirebench_greet.proto', files.get('wirebench_greet.proto')!]]);
    expect(() => protoSetFromDescriptors({ files: partial })).toThrow(
      expect.objectContaining({ code: 'proto-unresolved' }),
    );
  });
});
