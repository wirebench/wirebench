/**
 * What a Runner target covers (#336): a project, an API (any kind, a SOAP interface included), a folder,
 * one request or a sequence, found by its id in the open model. Requests come from the engine's own selection, so
 * the Runner runs exactly what `wirebench run` would, in the explorer's order; a target's saved order
 * and exclusions are then laid over it.
 */
import { selectRequests } from '@wirebench/engine';
import type { Project, ProtocolRegistry, SelectedRequest, SequenceDef } from '@wirebench/engine';
import type { RunnerRequest, RunnerSettings, RunnerTargetKind } from '../../shared/runner-wire.js';

export type RunnerTarget =
  | {
      readonly kind: Exclude<RunnerTargetKind, 'sequence'>;
      readonly id: string;
      readonly name: string;
      /** Every request the target holds, in explorer order. */
      readonly selected: readonly SelectedRequest[];
    }
  | { readonly kind: 'sequence'; readonly id: string; readonly name: string; readonly sequence: SequenceDef };

/** The API (or SOAP interface, or MCP server) a selected request belongs to. */
function containerOf(item: SelectedRequest): { readonly id: string; readonly name: string } | undefined {
  if ('api' in item) return item.api;
  if ('iface' in item) return item.iface;
  if ('server' in item) return item.server;
  return undefined;
}

/** The folders a selected request sits in, outermost first; none for a SOAP request. */
function foldersOf(item: SelectedRequest): readonly { readonly id: string; readonly name: string }[] {
  return 'chain' in item ? item.chain : [];
}

/** The target `targetId` names in `project`, or undefined when it names nothing a run can cover. */
export function resolveTarget(
  project: Project,
  targetId: string,
  registry?: ProtocolRegistry,
): RunnerTarget | undefined {
  const sequence = project.sequences.find((candidate) => candidate.id === targetId);
  if (sequence !== undefined) return { kind: 'sequence', id: targetId, name: sequence.name, sequence };
  const { selected } = selectRequests(project, [], registry);
  if (project.id === targetId) return { kind: 'project', id: targetId, name: project.name, selected };
  const inApi = selected.filter((item) => containerOf(item)?.id === targetId);
  if (inApi.length > 0) return { kind: 'api', id: targetId, name: containerOf(inApi[0]!)!.name, selected: inApi };
  const inFolder = selected.filter((item) => foldersOf(item).some((folder) => folder.id === targetId));
  if (inFolder.length > 0) {
    const folder = foldersOf(inFolder[0]!).find((candidate) => candidate.id === targetId)!;
    return { kind: 'folder', id: targetId, name: folder.name, selected: inFolder };
  }
  // One request: its iterations and data file, without the rest of its folder.
  const one = selected.find((item) => item.request.id === targetId);
  if (one !== undefined) return { kind: 'request', id: targetId, name: one.request.name, selected: [one] };
  return undefined;
}

/**
 * `selected` in the saved run order: ids the order names first, as it names them, then every request
 * it does not name (one added since) in explorer order. An id that no longer exists is dropped.
 */
export function inRunOrder(selected: readonly SelectedRequest[], order: readonly string[]): SelectedRequest[] {
  const byId = new Map(selected.map((item) => [item.request.id, item]));
  const named = order.flatMap((id) => {
    const item = byId.get(id);
    if (item === undefined) return [];
    byId.delete(id);
    return [item];
  });
  return [...named, ...selected.filter((item) => byId.has(item.request.id))];
}

/** What the target runs: in run order, without the excluded requests. */
export function runnable(selected: readonly SelectedRequest[], settings: RunnerSettings): SelectedRequest[] {
  const excluded = new Set(settings.excluded);
  return inRunOrder(selected, settings.order).filter((item) => !excluded.has(item.request.id));
}

/** The target's requests as the Runner tab lists them, in run order, excluded ones included. */
export function runnerRequests(target: RunnerTarget, settings: RunnerSettings): RunnerRequest[] {
  if (target.kind === 'sequence') {
    return target.sequence.steps.map((step, index) => ({
      id: step.id,
      name: step.name ?? step.requestId,
      path: `${String(index + 1)}. ${step.name ?? step.requestId}`,
      protocol: 'sequence-step',
    }));
  }
  return inRunOrder(target.selected, settings.order).map((item) => ({
    id: item.request.id,
    name: item.request.name,
    path: item.path,
    protocol: item.kind,
  }));
}
