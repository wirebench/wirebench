/**
 * Turning a `.proto` set into a gRPC API: a folder per service and a request per method, each
 * request seeded with a sample message — the shape an OpenAPI import produces, and the shape the
 * REST spec's §8 asked a gRPC import to reproduce. Pure: the caller reads the files and, when it
 * wants a cache, writes one with `cache.ts`.
 */

import type { IdGenerator } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import type { GrpcApi, GrpcDefinitionRef, GrpcFolder, GrpcRequestDef } from './model.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from './model.js';
import { describeServices } from './proto/describe.js';
import type { GrpcMethodDescriptor, GrpcServiceDescriptor } from './proto/describe.js';
import { loadProtoSet } from './proto/load.js';
import type { ProtoSet, ProtoSources } from './proto/load.js';
import { sampleMessageText } from './proto/sample.js';

/** Options for {@link importProto}. */
export interface ImportProtoOptions {
  /** The files to start from; defaults to every source. */
  readonly roots?: readonly string[];
  /** The API's name. Defaults to the first service's package, or its name when it has none. */
  readonly name?: string;
  readonly target?: string;
  readonly tls?: boolean;
  readonly definition?: GrpcDefinitionRef;
  readonly newId?: IdGenerator;
  readonly order?: number;
}

/** What an import produced, in numbers, for the summary step. */
export interface ProtoImportSummary {
  readonly files: number;
  readonly services: number;
  readonly methods: number;
  readonly deprecated: number;
}

/** The result of {@link importProto}. */
export interface ImportedProto {
  readonly api: GrpcApi;
  readonly set: ProtoSet;
  readonly services: readonly GrpcServiceDescriptor[];
  readonly summary: ProtoImportSummary;
}

/** A method's description: its leading comment, with a deprecation notice ahead of it. */
function requestDescription(method: GrpcMethodDescriptor): string | undefined {
  const parts = [method.deprecated === true ? '**Deprecated.**' : undefined, method.comment].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** One request per method, slugs unique within the folder. */
function requestsFor(set: ProtoSet, service: GrpcServiceDescriptor, options: ImportProtoOptions): GrpcRequestDef[] {
  const taken = new Set<string>();
  return service.methods.map((method, index) => {
    const slug = uniqueSlug(method.name, taken);
    taken.add(slug.toLowerCase());
    const description = requestDescription(method);
    return createGrpcRequest(method.name, {
      slug,
      order: index,
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
      ...(description !== undefined ? { description } : {}),
      service: service.fullName,
      method: method.name,
      methodKind: method.kind,
      message: sampleMessageText(set, method.requestType),
    });
  });
}

/**
 * Builds a gRPC API from an already-loaded set: a folder per service (named by its short name, the
 * package in the description when there is one), a request per method.
 */
export function apiFromProtoSet(set: ProtoSet, options: ImportProtoOptions = {}): ImportedProto {
  const services = describeServices(set);
  const folderSlugs = new Set<string>();
  const folders: GrpcFolder[] = services.map((service, index) => {
    const slug = uniqueSlug(service.name, folderSlugs);
    folderSlugs.add(slug.toLowerCase());
    const description = [service.package !== '' ? `Package \`${service.package}\`.` : undefined, service.comment]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' ');
    return createGrpcFolder(service.name, {
      slug,
      order: index,
      ...(options.newId !== undefined ? { newId: options.newId } : {}),
      ...(description !== '' ? { description } : {}),
      requests: requestsFor(set, service, options),
    });
  });
  const first = services[0];
  const name = options.name ?? (first === undefined ? 'gRPC API' : first.package !== '' ? first.package : first.name);
  const api = createGrpcApi(name, {
    ...(options.newId !== undefined ? { newId: options.newId } : {}),
    ...(options.order !== undefined ? { order: options.order } : {}),
    ...(options.target !== undefined ? { target: options.target } : {}),
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.definition !== undefined ? { definition: options.definition } : {}),
    folders,
  });
  const methods = services.flatMap((service) => service.methods);
  return {
    api,
    set,
    services,
    summary: {
      files: set.files.length,
      services: services.length,
      methods: methods.length,
      deprecated: methods.filter((method) => method.deprecated === true).length,
    },
  };
}

/**
 * Loads `sources` and builds an API from them.
 *
 * @throws ProtoError as {@link loadProtoSet} does
 */
export function importProto(sources: ProtoSources, options: ImportProtoOptions = {}): ImportedProto {
  const set = loadProtoSet(sources, options.roots !== undefined ? { roots: options.roots } : {});
  return apiFromProtoSet(set, options);
}
