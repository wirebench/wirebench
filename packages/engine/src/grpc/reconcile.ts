/**
 * Reconciling a gRPC API against a schema it has been given again — a server re-describing itself,
 * or the same `.proto` files re-read.
 *
 * The rule is the one "Update Definition" keeps for a WSDL: **nothing is ever deleted.** A method the
 * schema no longer declares keeps its saved request, flagged {@link GrpcRequestDef.orphaned}, because
 * a method that disappeared may mean "clean this up" or may mean the server was rebuilt wrong, and
 * that is the user's call. A method that came back has the flag cleared. A method the API does not
 * have yet gets a request, in the folder its service already owns or in a new one; what the user
 * edited — a message, metadata, credentials, settings — is never touched.
 *
 * Pure: it returns the next API and the ids of what changed, and writes nothing.
 */

import type { IdGenerator } from '../project/model.js';
import { uniqueSlug } from '../project/paths.js';
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from './model.js';
import { createGrpcFolder, createGrpcRequest } from './model.js';
import { describeServices } from './proto/describe.js';
import type { GrpcMethodDescriptor, GrpcServiceDescriptor } from './proto/describe.js';
import type { ProtoSet } from './proto/load.js';
import { sampleMessageText } from './proto/sample.js';

/** Options for {@link reconcileGrpcApi}. */
export interface ReconcileGrpcApiOptions {
  /** Mints ids for created folders and requests; injected by tests for determinism. */
  readonly newId?: IdGenerator;
}

/** What {@link reconcileGrpcApi} did, in ids the caller can report or select. */
export interface GrpcReconcileResult {
  readonly api: GrpcApi;
  /** Ids of requests created for methods the API did not have. */
  readonly requestsAdded: readonly string[];
  /** Ids of requests now flagged `orphaned` because their method is gone. */
  readonly requestsOrphaned: readonly string[];
  /** Ids of requests whose method is back, so the flag was cleared. */
  readonly requestsRestored: readonly string[];
  /** Ids of requests whose streaming shape changed, so `methodKind` was corrected. */
  readonly requestsRetyped: readonly string[];
  /** Ids of folders created for services the API did not have. */
  readonly foldersAdded: readonly string[];
}

/** A method's identity across two schemas. */
function methodKey(service: string, method: string): string {
  return `${service}/${method}`;
}

/** Every request under a folder tree, depth-first, with the folder holding it. */
function walkRequests(folders: readonly GrpcFolder[]): { folder: GrpcFolder; request: GrpcRequestDef }[] {
  return folders.flatMap((folder) => [
    ...folder.requests.map((request) => ({ folder, request })),
    ...walkRequests(folder.folders),
  ]);
}

/** A method's description: its leading comment, with a deprecation notice ahead of it. */
function requestDescription(method: GrpcMethodDescriptor): string | undefined {
  const parts = [method.deprecated === true ? '**Deprecated.**' : undefined, method.comment].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Brings `api` in line with `set`.
 *
 * @param api the API to reconcile; never mutated
 * @param set the schema it has been given again
 */
export function reconcileGrpcApi(
  api: GrpcApi,
  set: ProtoSet,
  options: ReconcileGrpcApiOptions = {},
): GrpcReconcileResult {
  const services = describeServices(set);
  const declared = new Map<string, { service: GrpcServiceDescriptor; method: GrpcMethodDescriptor }>();
  for (const service of services) {
    for (const method of service.methods) {
      declared.set(methodKey(service.fullName, method.name), { service, method });
    }
  }

  const requestsOrphaned: string[] = [];
  const requestsRestored: string[] = [];
  const requestsRetyped: string[] = [];
  const kept = new Set<string>();

  /** Re-flags one request against the schema, leaving everything the user edited alone. */
  const reconcileRequest = (request: GrpcRequestDef): GrpcRequestDef => {
    const found = declared.get(methodKey(request.service, request.method));
    if (found === undefined) {
      if (request.orphaned !== true) {
        requestsOrphaned.push(request.id);
        return { ...request, orphaned: true };
      }
      return request;
    }
    kept.add(methodKey(request.service, request.method));
    let next = request;
    if (next.orphaned === true) {
      requestsRestored.push(next.id);
      const { orphaned, ...rest } = next;
      void orphaned;
      next = rest;
    }
    if (next.methodKind !== found.method.kind) {
      requestsRetyped.push(next.id);
      next = { ...next, methodKind: found.method.kind };
    }
    return next;
  };

  const reconcileFolder = (folder: GrpcFolder): GrpcFolder => ({
    ...folder,
    requests: folder.requests.map(reconcileRequest),
    folders: folder.folders.map(reconcileFolder),
  });

  let next: GrpcApi = {
    ...api,
    requests: api.requests.map(reconcileRequest),
    folders: api.folders.map(reconcileFolder),
  };

  // Where a new request goes: the folder that already holds this service, anywhere in the tree.
  const folderOfService = new Map<string, string>();
  for (const { folder, request } of walkRequests(next.folders)) {
    if (!folderOfService.has(request.service)) {
      folderOfService.set(request.service, folder.id);
    }
  }

  const requestsAdded: string[] = [];
  const foldersAdded: string[] = [];
  const newRequests = new Map<string, GrpcRequestDef[]>();
  const rootFolderSlugs = new Set(next.folders.map((folder) => folder.slug.toLowerCase()));

  for (const service of services) {
    const missing = service.methods.filter((method) => !kept.has(methodKey(service.fullName, method.name)));
    if (missing.length === 0) {
      continue;
    }
    let folderId = folderOfService.get(service.fullName);
    if (folderId === undefined) {
      const slug = uniqueSlug(service.name, rootFolderSlugs);
      rootFolderSlugs.add(slug.toLowerCase());
      const description = [service.package !== '' ? `Package \`${service.package}\`.` : undefined, service.comment]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' ');
      const folder = createGrpcFolder(service.name, {
        slug,
        order: next.folders.length,
        ...(options.newId !== undefined ? { newId: options.newId } : {}),
        ...(description !== '' ? { description } : {}),
      });
      foldersAdded.push(folder.id);
      next = { ...next, folders: [...next.folders, folder] };
      folderId = folder.id;
      folderOfService.set(service.fullName, folderId);
    }
    const into = newRequests.get(folderId) ?? [];
    for (const method of missing) {
      const description = requestDescription(method);
      const request = createGrpcRequest(method.name, {
        ...(options.newId !== undefined ? { newId: options.newId } : {}),
        ...(description !== undefined ? { description } : {}),
        service: service.fullName,
        method: method.name,
        methodKind: method.kind,
        message: sampleMessageText(set, method.requestType),
      });
      requestsAdded.push(request.id);
      into.push(request);
    }
    newRequests.set(folderId, into);
  }

  /** Appends the new requests of each folder, slugs and orders unique within it. */
  const addInto = (folder: GrpcFolder): GrpcFolder => {
    const additions = newRequests.get(folder.id) ?? [];
    const folders = folder.folders.map(addInto);
    if (additions.length === 0) {
      return { ...folder, folders };
    }
    const taken = new Set(folder.requests.map((request) => request.slug.toLowerCase()));
    const numbered = additions.map((request, index) => {
      const slug = uniqueSlug(request.name, taken);
      taken.add(slug.toLowerCase());
      return { ...request, slug, order: folder.requests.length + index };
    });
    return { ...folder, folders, requests: [...folder.requests, ...numbered] };
  };

  next = { ...next, folders: next.folders.map(addInto) };
  return { api: next, requestsAdded, requestsOrphaned, requestsRestored, requestsRetyped, foldersAdded };
}
