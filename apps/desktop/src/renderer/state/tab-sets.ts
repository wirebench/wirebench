/**
 * Which set of editor tabs a tab belongs to, and which set each activity-bar area shows.
 *
 * Tabs are grouped by what they are: an SSH terminal lives with the Hosts area, an environment
 * with Environments, a history entry (and History's Compare) with History, and everything else —
 * requests, APIs, interfaces, mocks, sequences — with Explorer. The editor's strip shows only the
 * set of the area in view, so a terminal never sits between two requests. Search and
 * WS-Security open nothing of their own; they show Explorer's set.
 *
 * Pure functions only, so both stores can use them without importing each other.
 */
import type { AreaId } from '@shared/area-module.js';

export type TabSet = 'explorer' | 'environments' | 'history' | 'ssh';

/** The fields of a tab this module reads; `EditorTab` satisfies it. */
export interface TabSetSubject {
  readonly kind: string;
  /** Overrides the kind's set, for a tab whose kind is shared by two areas (History's Compare). */
  readonly set?: TabSet;
}

/** The set `tab` belongs to. */
export function tabSetOf(tab: TabSetSubject): TabSet {
  if (tab.set !== undefined) return tab.set;
  switch (tab.kind) {
    case 'ssh-terminal':
      return 'ssh';
    case 'environment':
      return 'environments';
    case 'history':
      return 'history';
    default:
      return 'explorer';
  }
}

/** The set the editor shows while `view` is the area in the sidebar. */
export function tabSetForView(view: AreaId): TabSet {
  switch (view) {
    case 'ssh':
      return 'ssh';
    case 'environments':
      return 'environments';
    case 'history':
      return 'history';
    default:
      return 'explorer';
  }
}

/**
 * The area to bring into view so `set` shows: `current` when it already shows that set (Search
 * keeps showing Explorer's tabs without being swapped out), otherwise the set's own area.
 */
export function viewForTabSet(set: TabSet, current: AreaId): AreaId {
  return tabSetForView(current) === set ? current : set;
}

/** `tabs` narrowed to `set`, in strip order. */
export function tabsInSet<T extends TabSetSubject>(tabs: readonly T[], set: TabSet): T[] {
  return tabs.filter((tab) => tabSetOf(tab) === set);
}
