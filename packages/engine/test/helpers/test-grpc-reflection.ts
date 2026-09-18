/**
 * The descriptor side of the test gRPC server: turning a loaded `.proto` set back into the encoded
 * `FileDescriptorProto`s a real server's reflection service answers with, and the tables that answer
 * `list_services`, `file_containing_symbol` and `file_by_filename` from them.
 *
 * Deliberately independent of the engine's reflection client: the descriptors come from protobufjs's
 * own `toDescriptor`, so a test proves the client against a second reading of the same schema rather
 * than against itself.
 *
 * One fidelity repair is needed. `Root.toDescriptor` synthesises one file per *package* — it has no
 * memory of which source file a type was parsed from — and it leaves every `dependency` list empty,
 * which no compiler would. A server whose files declare no imports would let the client's
 * dependency chase pass without ever running, so the edges are reconstructed here from the resolved
 * type references and written back into the descriptors before they are encoded. The file names stay
 * the synthetic per-package ones; nothing in the protocol requires them to match a path on disk.
 */

import protobuf from 'protobufjs';
import descriptorExt from 'protobufjs/ext/descriptor.js';
import type { ProtoSet } from '../../src/grpc/proto/load.js';

const FileDescriptorProto = (descriptorExt as unknown as Record<string, protobuf.Type>)['FileDescriptorProto']!;

/** One file as the reflection service has to serve it. */
export interface DescribedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly dependencies: readonly string[];
}

/** The descriptor tables a reflection service answers from. */
export interface ReflectionCatalog {
  /** Every file, keyed by the name its own descriptor carries. */
  readonly files: ReadonlyMap<string, DescribedFile>;
  /** The file each fully qualified symbol is declared in. */
  readonly symbols: ReadonlyMap<string, string>;
  /** The fully qualified service names, which `list_services` answers with. */
  readonly services: readonly string[];
}

interface RawFile {
  name?: string;
  package?: string;
  dependency?: string[];
  messageType?: { name?: string }[];
  enumType?: { name?: string }[];
  service?: { name?: string }[];
}

/** The package a declaration lives in: its ancestor namespaces, the messages it nests inside skipped. */
function packageOf(object: protobuf.ReflectionObject): string {
  const parts: string[] = [];
  let current: protobuf.ReflectionObject | null = object.parent;
  while (current !== null && current.parent !== null) {
    if (!(current instanceof protobuf.Type) && !(current instanceof protobuf.Enum)) {
      parts.unshift(current.name);
    }
    current = current.parent;
  }
  return parts.join('.');
}

/** Every declaration under `namespace`, depth-first. */
function declarations(namespace: protobuf.NamespaceBase): protobuf.ReflectionObject[] {
  return namespace.nestedArray.flatMap((child) => [
    child,
    ...(child instanceof protobuf.Namespace ? declarations(child) : []),
  ]);
}

/** Reads `set` back out as descriptors, the way a compiler would have handed them to a server. */
export function reflectionCatalog(set: ProtoSet): ReflectionCatalog {
  const raw = set.root.toDescriptor('proto3') as unknown as { readonly file: readonly RawFile[] };
  const named = raw.file.filter((file): file is RawFile & { name: string } => file.name !== undefined);
  const fileByPackage = new Map<string, string>(named.map((file) => [file.package ?? '', file.name]));
  const dependencies = new Map<string, Set<string>>(named.map((file) => [file.name, new Set<string>()]));

  const link = (from: protobuf.ReflectionObject, to: protobuf.ReflectionObject | null | undefined): void => {
    if (to === null || to === undefined) {
      return;
    }
    const source = fileByPackage.get(packageOf(from));
    const target = fileByPackage.get(packageOf(to));
    if (source !== undefined && target !== undefined && source !== target) {
      dependencies.get(source)?.add(target);
    }
  };
  for (const declaration of declarations(set.root)) {
    if (declaration instanceof protobuf.Type) {
      for (const field of declaration.fieldsArray) {
        field.resolve();
        link(declaration, field.resolvedType);
      }
    } else if (declaration instanceof protobuf.Service) {
      for (const method of declaration.methodsArray) {
        method.resolve();
        link(declaration, method.resolvedRequestType);
        link(declaration, method.resolvedResponseType);
      }
    }
  }

  const files = new Map<string, DescribedFile>();
  const symbols = new Map<string, string>();
  const services: string[] = [];
  for (const file of named) {
    const ordered = [...(dependencies.get(file.name) ?? [])].sort((a, b) => a.localeCompare(b));
    file.dependency = ordered;
    const prefix = file.package !== undefined && file.package !== '' ? `${file.package}.` : '';
    files.set(file.name, {
      name: file.name,
      bytes: FileDescriptorProto.encode(file).finish(),
      dependencies: ordered,
    });
    for (const declared of [...(file.messageType ?? []), ...(file.enumType ?? []), ...(file.service ?? [])]) {
      if (declared.name !== undefined && declared.name !== '') {
        symbols.set(`${prefix}${declared.name}`, file.name);
      }
    }
    for (const service of file.service ?? []) {
      if (service.name !== undefined && service.name !== '') {
        services.push(`${prefix}${service.name}`);
      }
    }
  }
  return { files, symbols, services };
}

/** The file named first, then every file it transitively imports — what a well-behaved server answers. */
export function withDependencies(catalog: ReflectionCatalog, name: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  const walk = (path: string): void => {
    if (seen.has(path)) {
      return;
    }
    seen.add(path);
    const file = catalog.files.get(path);
    if (file === undefined) {
      return;
    }
    out.push(file.bytes);
    for (const dependency of file.dependencies) {
      walk(dependency);
    }
  };
  walk(name);
  return out;
}
