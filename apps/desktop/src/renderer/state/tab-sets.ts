/**
 * Which set of editor tabs a tab belongs to, and which set each activity-bar area shows.
 *
 * There are two sets. SSH's terminals and file panes live with the Hosts area, so a terminal never
 * sits between two requests. Everything else — requests, APIs, interfaces, mocks, sequences, and
 * also environments, History entries and History's Compare — shares Explorer's strip (#607): a
 * request stays in view while its history is browsed or its variables are edited. Every area but
 * SSH shows Explorer's set.
 *
 * Pure functions only, so both stores can use them without importing each other.
 */
import type { AreaId } from '@shared/area-module.js';

export type TabSet = 'explorer' | 'ssh';

/** The fields of a tab this module reads; `EditorTab` satisfies it. */
export interface TabSetSubject {
  readonly kind: string;
}

/** The set `tab` belongs to. */
export function tabSetOf(tab: TabSetSubject): TabSet {
  switch (tab.kind) {
    case 'ssh-terminal':
    case 'ssh-files':
    case 'local-terminal':
      return 'ssh';
    default:
      return 'explorer';
  }
}

/** The set the editor shows while `view` is the area in the sidebar. */
export function tabSetForView(view: AreaId): TabSet {
  return view === 'ssh' ? 'ssh' : 'explorer';
}

/**
 * The area to bring into view so `set` shows: `current` when it already shows that set (History,
 * Environments and Search keep showing Explorer's tabs without being swapped out), otherwise the
 * set's own area.
 */
export function viewForTabSet(set: TabSet, current: AreaId): AreaId {
  return tabSetForView(current) === set ? current : set;
}

/** `tabs` narrowed to `set`, in strip order. */
export function tabsInSet<T extends TabSetSubject>(tabs: readonly T[], set: TabSet): T[] {
  return tabs.filter((tab) => tabSetOf(tab) === set);
}
