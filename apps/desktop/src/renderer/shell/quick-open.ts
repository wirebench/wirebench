/**
 * ⌘P — quick-open. The list behind the palette's second mode: every operation the open
 * projects' interfaces declare, and every request saved against them, each row naming the
 * project it belongs to.
 *
 * Pure selection logic, so the entries can be asserted on without mounting the palette. The
 * palette does the fuzzy matching itself (cmdk's own filter) over each entry's `value`.
 */

import type { InterfaceSummary, RequestWire } from '../../shared/wire-types.js';

/** One quick-open row. */
export interface QuickOpenEntry {
  /** `request:<id>` or `operation:<interfaceId>/<binding>/<name>` — unique, and a React key. */
  readonly key: string;
  readonly kind: 'request' | 'operation';
  /** What the row shows: the request name, or the operation name. */
  readonly label: string;
  /** The breadcrumb under it: `project › interface › binding › operation`. */
  readonly detail: string;
  /** What cmdk matches against — label and breadcrumb together. */
  readonly value: string;
  /** Set for `request`: the draft to open. */
  readonly requestId?: string;
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
 */
export function quickOpenEntries(
  interfaces: Readonly<Record<string, InterfaceSummary>>,
  requests: Readonly<Record<string, RequestWire>>,
  projectOf: Readonly<Record<string, string>> = {},
  projectNames: Readonly<Record<string, string>> = {},
): readonly QuickOpenEntry[] {
  const projectNameOf = (entityId: string): string | undefined => {
    const projectId = projectOf[entityId];
    return projectId === undefined ? undefined : projectNames[projectId];
  };

  const requestEntries: QuickOpenEntry[] = [];
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
