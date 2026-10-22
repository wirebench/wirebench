/**
 * The server reflection service, as a `.proto` the engine carries with it.
 *
 * A server that speaks reflection describes itself over a service the client must already know, so
 * this one definition cannot come from the user. It is a string constant rather than a shipped
 * `.proto` file because the engine builds with `tsc -b` alone and has no step that would copy an
 * asset into `dist/`; it is loaded through the same {@link loadProtoSet} every imported file goes
 * through, so the codec meets it exactly as it meets a user's own schema.
 *
 * Two packages exist for the same service. `grpc.reflection.v1alpha` is what servers shipped for
 * years; `grpc.reflection.v1` is the stable name, and the message shapes are identical — which is
 * why one template with the package substituted covers both rather than two copies that could drift.
 */

import { loadProtoSet } from '../proto/load.js';
import type { ProtoSet } from '../proto/load.js';

export type { GrpcReflectionVersion } from '../model.js';

/** The two versions a server may answer on, newest first — the order `auto` tries them in. */
export const REFLECTION_VERSIONS: readonly ['v1', 'v1alpha'] = ['v1', 'v1alpha'];

/** The `package` a version's service lives in. */
export function reflectionPackage(version: 'v1' | 'v1alpha'): string {
  return `grpc.reflection.${version}`;
}

/** The fully qualified service name for a version. */
export function reflectionServiceName(version: 'v1' | 'v1alpha'): string {
  return `${reflectionPackage(version)}.ServerReflection`;
}

/** The single method, a bidirectional stream whose exchange is request/response per message. */
export const REFLECTION_METHOD = 'ServerReflectionInfo';

/** The import path the reflection definition is loaded under. */
const REFLECTION_FILE = 'grpc/reflection/reflection.proto';

/**
 * `reflection.proto` with `__PACKAGE__` where the package name goes. Transcribed from the gRPC
 * specification's own definition; the field numbers are part of the wire contract, so the gaps
 * (`ServerReflectionRequest` has no field 2, `ServerReflectionResponse` no field 3) are deliberate.
 */
const REFLECTION_TEMPLATE = `syntax = "proto3";

package __PACKAGE__;

service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}

message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}

message ExtensionRequest {
  string containing_type = 1;
  int32 extension_number = 2;
}

message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}

message FileDescriptorResponse {
  repeated bytes file_descriptor_proto = 1;
}

message ExtensionNumberResponse {
  string base_type_name = 1;
  repeated int32 extension_number = 2;
}

message ListServiceResponse {
  repeated ServiceResponse service = 1;
}

message ServiceResponse {
  string name = 1;
}

message ErrorResponse {
  int32 error_code = 1;
  string error_message = 2;
}
`;

/** The reflection definition's source text for one version. */
export function reflectionProtoSource(version: 'v1' | 'v1alpha'): string {
  return REFLECTION_TEMPLATE.replaceAll('__PACKAGE__', reflectionPackage(version));
}

const cached = new Map<string, ProtoSet>();

/** The loaded reflection schema for one version, parsed once per process. */
export function reflectionProtoSet(version: 'v1' | 'v1alpha'): ProtoSet {
  const existing = cached.get(version);
  if (existing !== undefined) {
    return existing;
  }
  const set = loadProtoSet(new Map([[REFLECTION_FILE, reflectionProtoSource(version)]]), { roots: [REFLECTION_FILE] });
  cached.set(version, set);
  return set;
}

/**
 * The import path a descriptor file the engine loaded from a reflection response is called by, and
 * the partial `FileDescriptorProto` the client reads its name and dependencies from.
 *
 * A reflection response carries each file as encoded `FileDescriptorProto` bytes, and the client has
 * to know a file's own name (to key it, and to satisfy a later `file_by_filename`) and what it
 * imports (to notice a dependency the server did not volunteer) *before* it can build a schema out
 * of the set. Protobuf's unknown-field rule makes that cheap: decoding a full `FileDescriptorProto`
 * against a message declaring only fields 1 and 3 yields exactly those two and skips everything
 * else, so the engine needs no copy of `descriptor.proto` to read a file's header.
 */
const HEADER_FILE = 'grpc/reflection/descriptor-header.proto';

/** The message type {@link descriptorHeaderProtoSet} declares for one file. */
export const DESCRIPTOR_HEADER_TYPE = 'wirebench.reflection.FileDescriptorHeader';

/** The message type {@link descriptorHeaderProtoSet} declares for a whole set. */
export const DESCRIPTOR_SET_HEADER_TYPE = 'wirebench.reflection.FileDescriptorSetHeader';

const HEADER_SOURCE = `syntax = "proto3";

package wirebench.reflection;

// The first fields of google.protobuf.FileDescriptorProto. Every other field decodes as unknown and
// is skipped, which is all this client needs to key a file and follow its imports.
message FileDescriptorHeader {
  string name = 1;
  repeated string dependency = 3;
}

// google.protobuf.FileDescriptorSet, read one header deep: enough to list a cached set's files in
// the order they were written without decoding every declaration in them.
message FileDescriptorSetHeader {
  repeated FileDescriptorHeader file = 1;
}
`;

let headerSet: ProtoSet | undefined;

/** The partial `FileDescriptorProto` schema, parsed once per process. */
export function descriptorHeaderProtoSet(): ProtoSet {
  headerSet ??= loadProtoSet(new Map([[HEADER_FILE, HEADER_SOURCE]]), { roots: [HEADER_FILE] });
  return headerSet;
}
