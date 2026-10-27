/**
 * What a schedule can run, read from the open workspace (#517): the project's APIs, folders and requests
 * as `wirebench run` selectors, and its sequences by name. The server resolves the same selectors against
 * the workspace's main head when the schedule fires, so a selector is a display path (`API/Folder/Request`)
 * whenever that names exactly what was picked, and the request's path on disk when it does not (two
 * requests of one name in one folder).
 */
import { runSelectorOf, selectRequests } from '@wirebench/engine';
import type { Project, ProtocolRegistry, SelectedRequest } from '@wirebench/engine';
import type { ScheduleChoiceWire, ScheduleTargetWire } from '@wirebench/wire/schedules-wire';
import { resolveTarget } from '../runner/targets.js';

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

const covers = (selector: string, path: string): boolean => path === selector || path.startsWith(`${selector}/`);

/**
 * The selectors that name exactly `wanted` among `all`: one display path when it does, else each request
 * by its path on disk.
 */
function selectorsFor(
  project: Project,
  all: readonly SelectedRequest[],
  wanted: readonly SelectedRequest[],
  displayPath: string,
  registry: ProtocolRegistry | undefined,
): string[] {
  const ids = new Set(wanted.map((item) => item.request.id));
  const named = all.filter((item) => covers(displayPath, item.path));
  if (named.length === ids.size && named.every((item) => ids.has(item.request.id))) return [displayPath];
  return wanted.flatMap((item) => runSelectorOf(project, item.request.id, registry) ?? []);
}

/** The display path of a folder: its API's name and the folders down to it. */
function folderPath(item: SelectedRequest, folderId: string): string | undefined {
  const container = containerOf(item);
  const chain = foldersOf(item);
  const index = chain.findIndex((folder) => folder.id === folderId);
  if (container === undefined || index < 0) return undefined;
  return [container.name, ...chain.slice(0, index + 1).map((folder) => folder.name)].join('/');
}

/**
 * Every API, folder and request a schedule can pick, in explorer order, each with its selectors; and the
 * project's sequences. Webhook items are left out, as a run without selectors leaves them out.
 */
export function scheduleChoices(
  project: Project,
  registry?: ProtocolRegistry,
): { readonly items: ScheduleChoiceWire[]; readonly sequences: string[] } {
  const { selected } = selectRequests(project, [], registry);
  const items: ScheduleChoiceWire[] = [];
  const seen = new Set<string>();
  for (const item of selected) {
    const container = containerOf(item);
    if (container !== undefined && !seen.has(container.id)) {
      seen.add(container.id);
      const inContainer = selected.filter((other) => containerOf(other)?.id === container.id);
      items.push({
        id: container.id,
        kind: 'api',
        label: container.name,
        depth: 0,
        selectors: selectorsFor(project, selected, inContainer, container.name, registry),
      });
    }
    const chain = foldersOf(item);
    chain.forEach((folder, index) => {
      if (seen.has(folder.id)) return;
      seen.add(folder.id);
      const inFolder = selected.filter((other) => foldersOf(other).some((candidate) => candidate.id === folder.id));
      const path = folderPath(item, folder.id);
      items.push({
        id: folder.id,
        kind: 'folder',
        label: folder.name,
        depth: index + 1,
        selectors:
          path === undefined
            ? inFolder.flatMap((other) => runSelectorOf(project, other.request.id, registry) ?? [])
            : selectorsFor(project, selected, inFolder, path, registry),
      });
    });
    items.push({
      id: item.request.id,
      kind: 'request',
      label: item.request.name,
      depth: chain.length + (container === undefined ? 0 : 1),
      selectors: selectorsFor(project, selected, [item], item.path, registry),
    });
  }
  return { items, sequences: project.sequences.map((sequence) => sequence.name) };
}

/**
 * The target **Schedule…** on an explorer row fills in: the whole project, one sequence, or the
 * selectors of an API, folder or request. `undefined` for a row a run cannot cover.
 */
export function scheduleTargetFor(
  project: Project,
  entityId: string,
  registry?: ProtocolRegistry,
): ScheduleTargetWire | undefined {
  // The workspace manifest names a project by this id, and the server finds it by it.
  const workspaceProjectId = project.id;
  const target = resolveTarget(project, entityId, registry);
  if (target === undefined) return undefined;
  if (target.kind === 'project') return { project: workspaceProjectId };
  if (target.kind === 'sequence') return { project: workspaceProjectId, sequences: [target.name] };
  const choice = scheduleChoices(project, registry).items.find((candidate) => candidate.id === entityId);
  if (choice === undefined || choice.selectors.length === 0) return undefined;
  return { project: workspaceProjectId, select: choice.selectors };
}
