/**
 * Which requests a run covers, and in what order: the order the explorer shows, so a report reads
 * like the project. Every container shares one ordering space (see `Project.apis`). The requests
 * themselves come from the protocol modules: nothing here names a protocol.
 */
import type { Project } from '../project/model.js';
import type { RunGroup, SelectedBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest } from '../protocols.js';
import { byOrder } from './tree.js';

export type { SelectedRequest } from '../protocols.js';

interface Candidate {
  readonly item: SelectedBase;
  /** The request's path on disk, without the `.request.yaml` suffix. */
  readonly diskPath: string;
  /** In a group a run sends only when a selector names it (a webhook item). */
  readonly explicitOnly: boolean;
}

/**
 * A module's selection under the built-in union. A registry may hold a module that is not built in;
 * its items travel under this type too, and a caller that narrows on `kind` simply never matches them.
 */
const asSelected = (item: SelectedBase): SelectedRequest => item as SelectedRequest;

/** Every runnable request, container by container in explorer order, `explicitOnly` groups last. */
function candidates(project: Project, registry: ProtocolRegistry): Candidate[] {
  const groups: RunGroup[] = registry.modules.flatMap((module) => module.run?.groups(project) ?? []);
  const inOrder = [
    ...groups.filter((group) => group.explicitOnly !== true).sort(byOrder),
    ...groups.filter((group) => group.explicitOnly === true).sort(byOrder),
  ];
  return inOrder.flatMap((group) =>
    group.candidates.map(({ item, diskPath }) => ({ item, diskPath, explicitOnly: group.explicitOnly === true })),
  );
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
 * project's requests, in explorer order. An empty `selectors` list selects everything but the webhook
 * items: those deliver to a receiver rather than test an API, so a run sends one only when a selector
 * covers it (`Webhooks/…` or `webhooks/requests/…`). A gRPC request that streams, and a request its
 * contract no longer has, are skipped: neither is runnable from the command line yet, and there is no
 * per-selector reason to report — a selector naming one simply matches nothing and surfaces through
 * `unmatched`, same as a typo would. `unmatched` lists every selector that covered no request, so the
 * runner can refuse the run rather than quietly test nothing.
 *
 * `registry` is the set of protocol modules asked for their requests; the built-in ones by default.
 */
export function selectRequests(
  project: Project,
  selectors: readonly string[],
  registry: ProtocolRegistry = defaultRegistry(),
): { selected: SelectedRequest[]; unmatched: string[] } {
  const all = candidates(project, registry);
  if (selectors.length === 0) {
    return { selected: all.filter((c) => !c.explicitOnly).map((c) => asSelected(c.item)), unmatched: [] };
  }
  const matches = (selector: string, c: Candidate): boolean => {
    const s = normalise(selector);
    return covers(s, c.item.path) || covers(s, c.diskPath);
  };
  return {
    selected: all.filter((c) => selectors.some((s) => matches(s, c))).map((c) => asSelected(c.item)),
    unmatched: selectors.filter((s) => !all.some((c) => matches(s, c))),
  };
}

/** Where a sequence step's request id leads. */
export type StepRequestLookup =
  | { readonly kind: 'found'; readonly selected: SelectedRequest }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported'; readonly reason: string };

/**
 * Finds the request a sequence step names by id, among the requests a run can send, with the same
 * context `selectRequests` gives. A request that exists but cannot run (a webhook item, a streaming
 * gRPC call, one orphaned by its contract) says why, so the step errors with a reason rather than as
 * missing. Every module is asked for a reason before any candidate is looked
 * at: a webhook item is a candidate of a run, and still not a step.
 */
export function findStepRequest(
  project: Project,
  requestId: string,
  registry: ProtocolRegistry = defaultRegistry(),
): StepRequestLookup {
  for (const module of registry.modules) {
    const reason = module.run?.whyNotRunnable(project, requestId);
    if (reason !== undefined) {
      return { kind: 'unsupported', reason };
    }
  }
  const runnable = candidates(project, registry).find((candidate) => candidate.item.request.id === requestId);
  return runnable !== undefined ? { kind: 'found', selected: asSelected(runnable.item) } : { kind: 'missing' };
}
