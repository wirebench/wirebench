/**
 * ⌘P — quick-open. The list behind the palette's second mode: every operation the open
 * projects' interfaces declare, and every request saved against them, each row naming the
 * project it belongs to.
 *
 * Pure selection logic, so the entries can be asserted on without mounting the palette. The
 * palette does the fuzzy matching itself (cmdk's own filter) over each entry's `value`.
 */

import type { LayoutWire } from '../../shared/layout-wire.js';
import type { SnippetListItemWire } from '../../shared/snippets-wire.js';
import type { ResolvedHostWire } from '../../shared/ssh-wire.js';
import { layoutHosts, layoutPaneCount } from '../features/ssh/panes/open-layout.js';
import type { InterfaceSummary, RequestWire } from '../../shared/kinds/soap/wire.js';
import type { KindId } from '../../shared/kinds/kind-module.js';

/** One quick-open row. */
export interface QuickOpenEntry {
  /** `request:<id>` or `operation:<interfaceId>/<binding>/<name>` — unique, and a React key. */
  readonly key: string;
  readonly kind: 'request' | 'operation' | 'host' | 'layout' | 'snippet';
  /** Set for a `request` a protocol kind other than SOAP lists: whose `requests.open` opens it. */
  readonly requestKind?: KindId;
  /** What the row shows: the request name, or the operation name. */
  readonly label: string;
  /** The breadcrumb under it: `project › interface › binding › operation`. */
  readonly detail: string;
  /** What cmdk matches against — label and breadcrumb together. */
  readonly value: string;
  /** Set for `request`: the draft to open. */
  readonly requestId?: string;
  /** Set for `host`: the host whose terminal to open. */
  readonly hostId?: string;
  /** Set for `layout`: the saved layout to open. */
  readonly layoutId?: string;
  /** Set for `snippet`: the saved snippet to run. */
  readonly snippetId?: string;
  /** Set for `operation`: what a new request needs. */
  readonly interfaceId?: string;
  readonly bindingName?: string;
  readonly operationName?: string;
}

/**
 * Builds the quick-open list: requests first (what you are most likely reaching for), then the
 * operations that have no request yet — opening one of those creates its first request.
 *
 * Several projects can be open at once (interfaces/requests are already flattened across all of
 * them by the project store), so a row's detail — and, when the project is known, its label —
 * is prefixed with the owning project's name. `projectOf`/`projectNames` are optional and
 * default to empty maps so existing single-project callers (and their tests) are unaffected.
 *
 * @param interfaces - Every open project's interface summaries, keyed by id.
 * @param requests - Every open project's saved requests, keyed by id.
 * @param projectOf - Entity id (interface, request) → owning project id.
 * @param projectNames - Project id → display name.
 * @param kindRequests - The other kinds' saved requests, from {@link quickOpenKindEntries}; they sort in
 *   among the SOAP ones.
 */
export function quickOpenEntries(
  interfaces: Readonly<Record<string, InterfaceSummary>>,
  requests: Readonly<Record<string, RequestWire>>,
  projectOf: Readonly<Record<string, string>> = {},
  projectNames: Readonly<Record<string, string>> = {},
  kindRequests: readonly QuickOpenEntry[] = [],
): readonly QuickOpenEntry[] {
  const projectNameOf = (entityId: string): string | undefined => {
    const projectId = projectOf[entityId];
    return projectId === undefined ? undefined : projectNames[projectId];
  };

  const requestEntries: QuickOpenEntry[] = [...kindRequests];
  const covered = new Set<string>();

  for (const request of Object.values(requests)) {
    const interfaceName = interfaces[request.interfaceId]?.name ?? 'Interface';
    const binding = request.bindingName.replace(/^\{[^}]*\}/, '');
    const projectName = projectNameOf(request.id) ?? projectNameOf(request.interfaceId);
    const breadcrumb = `${interfaceName} › ${binding} › ${request.operationName}`;
    const detail = projectName === undefined ? breadcrumb : `${projectName} › ${breadcrumb}`;
    const label = projectName === undefined ? request.name : `${projectName} › ${request.name}`;
    covered.add(`${request.interfaceId}/${request.bindingName}/${request.operationName}`);
    requestEntries.push({
      key: `request:${request.id}`,
      kind: 'request',
      label,
      detail,
      value: `${label} ${detail}`,
      requestId: request.id,
    });
  }

  const operationEntries: QuickOpenEntry[] = [];
  for (const summary of Object.values(interfaces)) {
    const projectName = projectNameOf(summary.id);
    for (const operation of summary.operations) {
      if (covered.has(`${summary.id}/${operation.binding}/${operation.name}`)) {
        continue;
      }
      const breadcrumb = `${summary.name} › ${operation.bindingLocal} › ${operation.name}`;
      const detail = projectName === undefined ? breadcrumb : `${projectName} › ${breadcrumb}`;
      const label = projectName === undefined ? operation.name : `${projectName} › ${operation.name}`;
      operationEntries.push({
        key: `operation:${summary.id}/${operation.binding}/${operation.name}`,
        kind: 'operation',
        label,
        detail,
        value: `${label} ${detail}`,
        interfaceId: summary.id,
        bindingName: operation.binding,
        operationName: operation.name,
      });
    }
  }

  requestEntries.sort((a, b) => a.value.localeCompare(b.value));
  operationEntries.sort((a, b) => a.value.localeCompare(b.value));
  return [...requestEntries, ...operationEntries];
}

/** One saved request a protocol kind lists in Quick Open (its `requests.quickOpen`). */
export interface KindQuickOpenItem {
  readonly id: string;
  /** What leads the row: a REST method, or the kind's short name (`gRPC`, `WS`, `MCP`). */
  readonly tag: string;
  readonly name: string;
  /** The API (or server) it belongs to, and that container's name. */
  readonly apiId: string;
  readonly apiName: string;
  /** The folder it sits in; absent at the container's root. */
  readonly folderId?: string;
  /** More text the row matches on but does not show: a URL, a service and method. */
  readonly match?: string;
}

/** Where a kind's requests sit, for their breadcrumbs. */
export interface QuickOpenPlaces {
  /** Folders by id, every kind's: a name and the folder holding it. */
  readonly folders: Readonly<Record<string, { readonly name: string; readonly parentId?: string | undefined }>>;
  /** Entity id → owning project id. */
  readonly projectOf: Readonly<Record<string, string>>;
  /** Project id → display name. */
  readonly projectNames: Readonly<Record<string, string>>;
}

/** The folder names from the container's root down to `folderId`. A cycle or a missing folder ends the walk. */
function folderPath(folderId: string | undefined, folders: QuickOpenPlaces['folders']): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let id = folderId; id !== undefined && !seen.has(id); id = folders[id]?.parentId) {
    seen.add(id);
    const folder = folders[id];
    if (folder === undefined) break;
    names.unshift(folder.name);
  }
  return names;
}

/**
 * One kind's saved requests as quick-open rows: `METHOD name`, with `project › API › folder` under it. The
 * match also covers what the kind adds (a REST request's URL), so a path finds the request.
 *
 * @param kind - The kind whose `requests.open` opens a row.
 * @param items - The kind's `requests.quickOpen` list.
 * @param places - Folder names and the projects, for the breadcrumb.
 */
export function quickOpenKindEntries(
  kind: KindId,
  items: readonly KindQuickOpenItem[],
  places: QuickOpenPlaces,
): QuickOpenEntry[] {
  return items.map((item) => {
    const projectId = places.projectOf[item.id] ?? places.projectOf[item.apiId];
    const projectName = projectId === undefined ? undefined : places.projectNames[projectId];
    const label = `${item.tag} ${item.name}`;
    const detail = [
      ...(projectName === undefined ? [] : [projectName]),
      item.apiName,
      ...folderPath(item.folderId, places.folders),
    ].join(' › ');
    return {
      key: `${kind}-request:${item.id}`,
      kind: 'request',
      requestKind: kind,
      label,
      detail,
      value: [label, detail, item.match ?? ''].filter((part) => part !== '').join(' '),
      requestId: item.id,
    };
  });
}

/**
 * The hosts the Hosts area has resolved, as quick-open rows: the host name, with its address and group path
 * under it. The path shows the groups' names (an id with no name stays as it is). The match covers name,
 * address, path and tags. Only hosts in `resolved` are listed.
 *
 * @param resolved - The hosts store's resolved hosts.
 * @param groupNames - Group id → name.
 */
export function quickOpenHostEntries(
  resolved: readonly ResolvedHostWire[],
  groupNames: ReadonlyMap<string, string> = new Map(),
): readonly QuickOpenEntry[] {
  return resolved.map((host) => {
    const path = host.path.map((id) => groupNames.get(id) ?? id);
    return {
      key: `host:${host.id}`,
      kind: 'host',
      label: host.name,
      detail: path.length === 0 ? host.address : `${host.address} · ${path.join('/')}`,
      value: [host.name, host.address, ...path, ...host.tags].join(' '),
      hostId: host.id,
    };
  });
}

/**
 * Splits host rows into the recent ones, in the order of `recentIds` (newest first, at most `limit`), and the
 * rest in their own order. An id with no row (a deleted host) is skipped.
 *
 * @param entries - Host rows from {@link quickOpenHostEntries}.
 * @param recentIds - Host ids connected to lately, newest first.
 */
export function splitRecentHosts(
  entries: readonly QuickOpenEntry[],
  recentIds: readonly string[],
  limit = 5,
): { recent: QuickOpenEntry[]; rest: QuickOpenEntry[] } {
  const byHost = new Map(entries.map((entry) => [entry.hostId, entry] as const));
  const recent = recentIds.flatMap((id) => byHost.get(id) ?? []).slice(0, limit);
  const picked = new Set(recent);
  return { recent, rest: entries.filter((entry) => !picked.has(entry)) };
}

/**
 * The saved layouts as quick-open rows: the name, with its hosts and pane count under it. The match covers the
 * name and the host names.
 *
 * @param layouts - The open workspace's layouts.
 * @param nameOf - A host id's name.
 */
export function quickOpenLayoutEntries(
  layouts: readonly LayoutWire[],
  nameOf: (hostId: string) => string,
): readonly QuickOpenEntry[] {
  return layouts.map((layout) => {
    const hosts = layoutHosts(layout.root).map(nameOf);
    const count = layoutPaneCount(layout.root);
    return {
      key: `layout:${layout.id}`,
      kind: 'layout',
      label: layout.name,
      detail: `${hosts.join(', ')} · ${String(count)} ${count === 1 ? 'pane' : 'panes'}`,
      value: [layout.name, ...hosts].join(' '),
      layoutId: layout.id,
    };
  });
}

/**
 * The saved snippets as rows, in list order: the name, with its package and first line under it. The match
 * covers name, package, tags and first line; ⌘K's snippets mode, ⌘P and the terminal picker all use it.
 *
 * @param items - The snippets store's list.
 */
export function quickOpenSnippetEntries(items: readonly SnippetListItemWire[]): readonly QuickOpenEntry[] {
  return items.map((item) => ({
    key: `snippet:${item.id}`,
    kind: 'snippet',
    label: item.name,
    detail: item.packageName === undefined ? item.firstLine : `${item.packageName} · ${item.firstLine}`,
    value: [item.name, item.packageName ?? '', ...item.tags, item.firstLine].filter((part) => part !== '').join(' '),
    snippetId: item.id,
  }));
}
