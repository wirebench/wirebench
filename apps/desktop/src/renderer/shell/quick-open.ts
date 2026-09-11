/**
 * ⌘P — quick-open. The list behind the palette's second mode: every operation the project's
 * interfaces declare, and every request saved against them.
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
  /** The breadcrumb under it: `interface › binding › operation`. */
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
 * @param interfaces - The project's interface summaries, keyed by id.
 * @param requests - The project's saved requests, keyed by id.
 */
export function quickOpenEntries(
  interfaces: Readonly<Record<string, InterfaceSummary>>,
  requests: Readonly<Record<string, RequestWire>>,
): readonly QuickOpenEntry[] {
  const requestEntries: QuickOpenEntry[] = [];
  const covered = new Set<string>();

  for (const request of Object.values(requests)) {
    const interfaceName = interfaces[request.interfaceId]?.name ?? 'Interface';
    const binding = request.bindingName.replace(/^\{[^}]*\}/, '');
    const detail = `${interfaceName} › ${binding} › ${request.operationName}`;
    covered.add(`${request.interfaceId}/${request.bindingName}/${request.operationName}`);
    requestEntries.push({
      key: `request:${request.id}`,
      kind: 'request',
      label: request.name,
      detail,
      value: `${request.name} ${detail}`,
      requestId: request.id,
    });
  }

  const operationEntries: QuickOpenEntry[] = [];
  for (const summary of Object.values(interfaces)) {
    for (const operation of summary.operations) {
      if (covered.has(`${summary.id}/${operation.binding}/${operation.name}`)) {
        continue;
      }
      const detail = `${summary.name} › ${operation.bindingLocal} › ${operation.name}`;
      operationEntries.push({
        key: `operation:${summary.id}/${operation.binding}/${operation.name}`,
        kind: 'operation',
        label: operation.name,
        detail,
        value: `${operation.name} ${detail}`,
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
