/**
 * Building a {@link ProtoSet} out of the encoded `FileDescriptorProto`s a server's reflection
 * response carries, so a discovered schema and an imported one are the same thing downstream.
 *
 * An import parses `.proto` text; reflection receives the compiler's own output instead, one
 * `FileDescriptorProto` per file. protobufjs reads that form through `Root.fromDescriptor`, which
 * its `ext/descriptor` extension installs onto `Root` as a side effect — hence the bare import
 * below, which also brings the type declaration for the method with it. The set it produces is
 * indistinguishable to `describeServices`, the codec and `apiFromProtoSet` from a parsed one, so
 * everything the import pipeline does after loading is reused unchanged.
 */

import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor.js';
import { ProtoError } from '../../errors.js';
import { decodeMessage } from '../codec.js';
import type { ProtoSet } from '../proto/load.js';
import { DESCRIPTOR_HEADER_TYPE, DESCRIPTOR_SET_HEADER_TYPE, descriptorHeaderProtoSet } from './proto.js';

/** A file's own name and the files it imports, read from its descriptor without a full decode. */
export interface DescriptorHeader {
  /** The file's name as the compiler recorded it, which is also what an `import` in another file spells. */
  readonly name: string;
  /** The names this file imports, in declaration order. */
  readonly dependencies: readonly string[];
}

/**
 * Reads a descriptor's `name` and `dependency` list.
 *
 * @throws ProtoError `grpc-reflection-descriptor` when the bytes are not a readable descriptor
 */
export function descriptorHeader(bytes: Uint8Array): DescriptorHeader {
  let decoded: unknown;
  try {
    decoded = decodeMessage(descriptorHeaderProtoSet(), DESCRIPTOR_HEADER_TYPE, bytes);
  } catch (error) {
    throw new ProtoError('grpc-reflection-descriptor', 'The server sent a file descriptor this client could not read', {
      cause: error,
      details: { bytes: bytes.byteLength },
    });
  }
  const record = (decoded ?? {}) as { name?: unknown; dependency?: unknown };
  const name = typeof record.name === 'string' ? record.name : '';
  const dependencies = Array.isArray(record.dependency)
    ? record.dependency.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { name, dependencies };
}

/**
 * Wraps encoded `FileDescriptorProto`s in a `FileDescriptorSet`.
 *
 * `FileDescriptorSet` is one repeated message field, number 1, so the encoding is a length-delimited
 * record per file and nothing has to be re-serialised: the server's bytes go through untouched, which
 * is the same byte-exactness the `.proto` cache keeps.
 */
export function encodeFileDescriptorSet(files: readonly Uint8Array[]): Uint8Array {
  const writer = new protobuf.Writer();
  for (const file of files) {
    writer.uint32(0x0a).bytes(file);
  }
  return writer.finish();
}

/** Reads the file names of a whole `FileDescriptorSet`, in the order it stores them. */
export function descriptorSetHeaders(bytes: Uint8Array): DescriptorHeader[] {
  let decoded: unknown;
  try {
    decoded = decodeMessage(descriptorHeaderProtoSet(), DESCRIPTOR_SET_HEADER_TYPE, bytes);
  } catch (error) {
    throw new ProtoError('grpc-reflection-descriptor', 'The descriptor set could not be read', {
      cause: error,
      details: { bytes: bytes.byteLength },
    });
  }
  const files = (decoded as { file?: unknown }).file;
  return (Array.isArray(files) ? files : []).map((file) => {
    const record = (file ?? {}) as { name?: unknown; dependency?: unknown };
    return {
      name: typeof record.name === 'string' ? record.name : '',
      dependencies: Array.isArray(record.dependency)
        ? record.dependency.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  });
}

/**
 * Orders files so every file comes after the ones it imports. protobufjs resolves references as it
 * adds each file, and a file naming a type from one added later would not find it.
 */
export function orderDescriptors(files: ReadonlyMap<string, Uint8Array>): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    const bytes = files.get(name);
    if (bytes === undefined) {
      return;
    }
    for (const dependency of descriptorHeader(bytes).dependencies) {
      add(dependency);
    }
    ordered.push(name);
  };
  for (const name of files.keys()) {
    add(name);
  }
  return ordered;
}

/** The collected descriptors as one `FileDescriptorSet`, dependencies first. */
export function descriptorSetBytes(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return encodeFileDescriptorSet(orderDescriptors(files).map((name) => files.get(name)!));
}

/** Options for {@link protoSetFromDescriptorSet}. */
export interface ProtoSetFromDescriptorSetOptions {
  /** The files to record as the set's roots. Defaults to every file in it. */
  readonly roots?: readonly string[];
}

/**
 * Resolves an encoded `FileDescriptorSet` into a loaded schema — the form the describe, sample and
 * codec modules read, and the form a cached reflection definition is stored in.
 *
 * @throws ProtoError `grpc-reflection-empty` when the set has no files, `proto-unresolved` when a
 * type reference in it resolves to nothing, which is what a set missing a dependency looks like
 */
export function protoSetFromDescriptorSet(bytes: Uint8Array, options: ProtoSetFromDescriptorSetOptions = {}): ProtoSet {
  const files = descriptorSetHeaders(bytes).map((header) => header.name);
  if (files.length === 0) {
    throw new ProtoError('grpc-reflection-empty', 'The descriptor set describes no files');
  }
  let root: protobuf.Root;
  try {
    root = protobuf.Root.fromDescriptor(bytes, { keepCase: true });
    root.resolveAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProtoError('proto-unresolved', message, { cause: error });
  }
  return { root, files, roots: [...(options.roots ?? files)] };
}

/** Input to {@link protoSetFromDescriptors}. */
export interface ProtoSetFromDescriptorsInput {
  /** Every descriptor collected, keyed by the file name its own header carries. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The files the discovery started from — the ones declaring the services. Defaults to every file. */
  readonly roots?: readonly string[];
}

/**
 * Resolves a set of descriptors into a loaded schema.
 *
 * @throws as {@link protoSetFromDescriptorSet}
 */
export function protoSetFromDescriptors(input: ProtoSetFromDescriptorsInput): ProtoSet {
  if (input.files.size === 0) {
    throw new ProtoError('grpc-reflection-empty', 'The server described no files');
  }
  return protoSetFromDescriptorSet(
    descriptorSetBytes(input.files),
    input.roots !== undefined ? { roots: input.roots } : {},
  );
}
