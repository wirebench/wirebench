/**
 * Which requests a run covers, and in what order: the order the explorer shows, so a report reads
 * like the project. Interfaces and APIs share one ordering space (see `Project.apis`).
 */
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from '../grpc/model.js';
import type { Interface, OperationDef, Project, SoapRequestDef } from '../project/model.js';
import { WEBHOOKS_DIR, REQUESTS_DIR } from '../project/paths.js';
import type { RestApi, RestFolder, RestRequestDef } from '../rest/model.js';
import { createApi } from '../rest/model.js';
import type { WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import { effectiveTarget } from '../webhooks/model.js';

/** One saved request selected for a run, with enough context to send and report it. */
export type SelectedRequest =
  | {
      readonly kind: 'soap';
      readonly path: string;
      readonly group: string;
      readonly iface: Interface;
      readonly operation: OperationDef;
      readonly request: SoapRequestDef;
    }
  | {
      readonly kind: 'rest';
      readonly path: string;
      readonly group: string;
      readonly api: RestApi;
      readonly chain: readonly RestFolder[];
      readonly request: RestRequestDef;
    }
  | {
      readonly kind: 'grpc';
      readonly path: string;
      readonly group: string;
      readonly api: GrpcApi;
      readonly chain: readonly GrpcFolder[];
      readonly request: GrpcRequestDef;
    };

interface Candidate {
  readonly item: SelectedRequest;
  /** The request's path on disk, without the `.request.yaml` suffix. */
  readonly diskPath: string;
}

const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

/** What a REST or gRPC request tree's nodes have in common, as far as the walk below cares. */
interface TreeRequest {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
}
interface TreeFolder<F, R> {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
  readonly folders: readonly F[];
  readonly requests: readonly R[];
}

/** A folder's request or sub-folder child, tagged so the sort below need not narrow a union. */
type TreeChild<F, R> =
  | { readonly tag: 'request'; readonly order: number; readonly name: string; readonly request: R }
  | { readonly tag: 'folder'; readonly order: number; readonly name: string; readonly folder: F };

/**
 * Walks a REST or gRPC API's request tree in explorer order. `make` turns a request the protocol
 * can run into its selection, or answers `undefined` for one it skips (orphaned, streaming).
 */
function walkTree<F extends TreeFolder<F, R>, R extends TreeRequest>(
  node: { readonly folders: readonly F[]; readonly requests: readonly R[] },
  chain: readonly F[],
  group: string,
  diskDir: string,
  make: (request: R, chain: readonly F[], group: string) => SelectedRequest | undefined,
  out: Candidate[],
): void {
  const children: TreeChild<F, R>[] = [
    ...node.requests.map((request): TreeChild<F, R> => ({
      tag: 'request',
      order: request.order,
      name: request.name,
      request,
    })),
    ...node.folders.map((folder): TreeChild<F, R> => ({
      tag: 'folder',
      order: folder.order,
      name: folder.name,
      folder,
    })),
  ].sort(byOrder);
  for (const child of children) {
    if (child.tag === 'request') {
      const item = make(child.request, chain, group);
      if (item !== undefined) {
        out.push({ item, diskPath: `${diskDir}/${child.request.slug}` });
      }
    } else {
      walkTree(
        child.folder,
        [...chain, child.folder],
        `${group}/${child.folder.name}`,
        `${diskDir}/${child.folder.slug}`,
        make,
        out,
      );
    }
  }
}

function walkRest(api: RestApi, out: Candidate[]): void {
  walkTree<RestFolder, RestRequestDef>(
    api,
    [],
    api.name,
    `apis/${api.slug}/requests`,
    (request, chain, group) =>
      request.orphaned === true
        ? undefined
        : { kind: 'rest', path: `${group}/${request.name}`, group, api, chain, request },
    out,
  );
}

/** Unary calls only: a stream needs an assertion model of its own, which a run does not have yet. */
function walkGrpc(api: GrpcApi, out: Candidate[]): void {
  walkTree<GrpcFolder, GrpcRequestDef>(
    api,
    [],
    api.name,
    `apis/${api.slug}/requests`,
    (request, chain, group) =>
      request.orphaned === true || request.methodKind !== 'unary'
        ? undefined
        : { kind: 'grpc', path: `${group}/${request.name}`, group, api, chain, request },
    out,
  );
}

/**
 * The project's webhook items, as REST items against a synthetic API whose base URL is each item's
 * effective target (plan R3). A run has no history, so a callback uses the target.
 */
function walkWebhooks(collection: WebhookCollection, out: Candidate[]): void {
  const visit = (
    folders: readonly WebhookFolder[],
    requests: readonly RestRequestDef[],
    chain: readonly WebhookFolder[],
  ): void => {
    const group = ['Webhooks', ...chain.map((folder) => folder.name)].join('/');
    const dir = [WEBHOOKS_DIR, REQUESTS_DIR, ...chain.map((folder) => folder.slug)].join('/');
    const api = createApi('Webhooks', {
      id: 'webhooks',
      slug: 'webhooks',
      baseUrl: effectiveTarget(collection, chain),
      ...(collection.auth !== undefined ? { auth: collection.auth } : {}),
    });
    for (const request of [...requests].sort(byOrder)) {
      if (request.orphaned === true) continue;
      out.push({
        item: {
          kind: 'rest',
          path: `${group}/${request.name}`,
          group,
          api,
          chain: chain as unknown as readonly RestFolder[],
          request,
        },
        diskPath: `${dir}/${request.slug}`,
      });
    }
    for (const folder of [...folders].sort(byOrder)) visit(folder.folders, folder.requests, [...chain, folder]);
  };
  visit(collection.folders, collection.requests, []);
}

function candidates(project: Project): Candidate[] {
  const out: Candidate[] = [];
  for (const container of [...project.interfaces, ...project.apis, ...project.grpcApis].sort(byOrder)) {
    if (container.kind === 'rest') {
      walkRest(container, out);
      continue;
    }
    if (container.kind === 'grpc') {
      walkGrpc(container, out);
      continue;
    }
    for (const operation of [...container.operations].sort(byOrder)) {
      const group = `${container.name}/${operation.name}`;
      for (const request of [...operation.requests].sort(byOrder)) {
        if (request.orphaned !== true) {
          out.push({
            item: { kind: 'soap', path: `${group}/${request.name}`, group, iface: container, operation, request },
            diskPath: `interfaces/${container.slug}/operations/${operation.slug}/${request.slug}`,
          });
        }
      }
    }
  }
  if (project.webhooks !== undefined) walkWebhooks(project.webhooks, out);
  return out;
}

function normalise(selector: string): string {
  return selector
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.request\.yaml$/, '')
    .replace(/\/$/, '');
}

const covers = (selector: string, candidate: string): boolean =>
  candidate === selector || candidate.startsWith(`${selector}/`);

/**
 * Resolves `selectors` (display paths or on-disk paths, matched at a `/` boundary) against the
 * project's requests, in explorer order. An empty `selectors` list selects everything. A WebSocket
 * API, and a gRPC request that streams, are skipped: neither is runnable from the command line yet,
 * and there is no per-selector reason to report — a selector naming one simply matches nothing and
 * surfaces through `unmatched`, same as a typo would. `unmatched` lists every selector that covered no
 * request, so the runner can refuse the run rather than quietly test nothing.
 */
export function selectRequests(
  project: Project,
  selectors: readonly string[],
): { selected: SelectedRequest[]; unmatched: string[] } {
  const all = candidates(project);
  if (selectors.length === 0) {
    return { selected: all.map((c) => c.item), unmatched: [] };
  }
  const matches = (selector: string, c: Candidate): boolean => {
    const s = normalise(selector);
    return covers(s, c.item.path) || covers(s, c.diskPath);
  };
  return {
    selected: all.filter((c) => selectors.some((s) => matches(s, c))).map((c) => c.item),
    unmatched: selectors.filter((s) => !all.some((c) => matches(s, c))),
  };
}

/** Where a sequence step's request id leads. */
export type StepRequestLookup =
  | { readonly kind: 'found'; readonly selected: SelectedRequest }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported'; readonly reason: string };

interface RequestTree {
  readonly folders: readonly RequestTree[];
  readonly requests: readonly { readonly id: string }[];
}

function findInTree<R extends { readonly id: string }>(
  tree: { readonly folders: readonly RequestTree[]; readonly requests: readonly R[] },
  id: string,
): R | undefined {
  const own = tree.requests.find((request) => request.id === id);
  if (own !== undefined) {
    return own;
  }
  for (const folder of tree.folders) {
    const found = findInTree(folder as typeof tree, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Finds the request a sequence step names by id, among the requests a run can send, with the same
 * context `selectRequests` gives. A request that exists but cannot run (a WebSocket request, a streaming
 * gRPC call, one orphaned by its contract) says why, so the step errors with a reason rather than as
 * missing.
 */
export function findStepRequest(project: Project, requestId: string): StepRequestLookup {
  if (project.webhooks !== undefined && findInTree(project.webhooks, requestId) !== undefined) {
    return { kind: 'unsupported', reason: 'A webhook cannot be a sequence step' };
  }
  const runnable = candidates(project).find((candidate) => candidate.item.request.id === requestId);
  if (runnable !== undefined) {
    return { kind: 'found', selected: runnable.item };
  }
  const orphaned = { kind: 'unsupported', reason: 'The request is no longer in its contract (orphaned)' } as const;
  for (const iface of project.interfaces) {
    for (const operation of iface.operations) {
      if (operation.requests.some((request) => request.id === requestId)) {
        return orphaned;
      }
    }
  }
  for (const api of project.apis) {
    if (findInTree(api, requestId) !== undefined) {
      return orphaned;
    }
  }
  for (const api of project.grpcApis) {
    const request = findInTree(api, requestId);
    if (request !== undefined) {
      return request.methodKind !== 'unary'
        ? { kind: 'unsupported', reason: 'A streaming gRPC call cannot be a sequence step; only unary calls can' }
        : orphaned;
    }
  }
  for (const api of project.wsApis) {
    if (findInTree(api, requestId) !== undefined) {
      return { kind: 'unsupported', reason: 'A WebSocket request cannot be a sequence step' };
    }
  }
  return { kind: 'missing' };
}
