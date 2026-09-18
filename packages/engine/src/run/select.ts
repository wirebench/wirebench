/**
 * Which requests a run covers, and in what order: the order the explorer shows, so a report reads
 * like the project. Interfaces and APIs share one ordering space (see `Project.apis`).
 */
import type { Interface, OperationDef, Project, SoapRequestDef } from '../project/model.js';
import type { RestApi, RestFolder, RestRequestDef } from '../rest/model.js';

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
    };

interface Candidate {
  readonly item: SelectedRequest;
  /** The request's path on disk, without the `.request.yaml` suffix. */
  readonly diskPath: string;
}

const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

/** A REST folder's request or sub-folder child, tagged so the sort below need not narrow a union. */
type RestChild =
  | { readonly tag: 'request'; readonly order: number; readonly name: string; readonly request: RestRequestDef }
  | { readonly tag: 'folder'; readonly order: number; readonly name: string; readonly folder: RestFolder };

function walkRest(
  api: RestApi,
  chain: readonly RestFolder[],
  node: RestApi | RestFolder,
  group: string,
  diskDir: string,
  out: Candidate[],
): void {
  const children: RestChild[] = [
    ...node.requests.map((request): RestChild => ({
      tag: 'request',
      order: request.order,
      name: request.name,
      request,
    })),
    ...node.folders.map((folder): RestChild => ({ tag: 'folder', order: folder.order, name: folder.name, folder })),
  ].sort(byOrder);
  for (const child of children) {
    if (child.tag === 'request') {
      if (child.request.orphaned !== true) {
        out.push({
          item: { kind: 'rest', path: `${group}/${child.request.name}`, group, api, chain, request: child.request },
          diskPath: `${diskDir}/${child.request.slug}`,
        });
      }
    } else {
      walkRest(
        api,
        [...chain, child.folder],
        child.folder,
        `${group}/${child.folder.name}`,
        `${diskDir}/${child.folder.slug}`,
        out,
      );
    }
  }
}

function candidates(project: Project): Candidate[] {
  const out: Candidate[] = [];
  for (const container of [...project.interfaces, ...project.apis].sort(byOrder)) {
    if (container.kind === 'rest') {
      walkRest(container, [], container, container.name, `apis/${container.slug}/requests`, out);
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
 * project's requests, in explorer order. An empty `selectors` list selects everything. A gRPC API
 * is skipped: it is not runnable in this slice. `unmatched` lists every selector that covered no
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
