import type { FeatureDescriptor } from '@wirebench/engine';
import type { CommandId } from './commands.js';
import { explorerArea } from './areas/explorer.js';
import { environmentsArea } from './areas/environments.js';
import { searchArea } from './areas/search.js';
import { historyArea } from './areas/history.js';
import { wssArea } from './areas/wss.js';

/** The words the sidebar header and empty state show. Was `VIEWS` in `shell/sidebar.tsx`. */
export interface AreaCopy {
  readonly title: string;
  readonly headline: string;
  readonly body: string;
}

/**
 * One desktop area: a rail item, a sidebar view, commands and (optionally) IPC channels. This half is
 * process-neutral; the renderer and main halves are looked up by `id` (`renderer/areas/index.ts`,
 * `main/areas.ts`).
 *
 * @internal Composed statically in `AREAS`; not yet a plugin API (ADR-0017).
 */
export interface AreaModule<Id extends string = string> {
  readonly id: Id;
  /** Reused from the engine so switches and `whyDisabled()` behave the same everywhere. */
  readonly feature: FeatureDescriptor;
  readonly rail: {
    readonly label: string;
    /** Lucide icon name; the renderer maps it to the component so `shared/` stays free of React. */
    readonly icon: 'FolderTree' | 'Braces' | 'Search' | 'History' | 'ShieldCheck' | 'TerminalSquare';
    /** The command that shows the view; its shortcut labels the rail item. */
    readonly command: CommandId;
    readonly order: number;
    readonly testId?: string;
  };
  readonly copy: AreaCopy;
}

export const AREAS = [explorerArea, environmentsArea, searchArea, historyArea, wssArea] as const;

export type AreaId = (typeof AREAS)[number]['id'];

export function areaById(id: AreaId): AreaModule<AreaId> {
  const area = AREAS.find((candidate) => candidate.id === id);
  if (!area) throw new Error(`unknown area: ${String(id)}`);
  return area;
}

/**
 * The ids left on after `switches` (`{ ssh: false }`) are applied, in rail order. Mirrors the engine's
 * `createFeatureSet` rules (switch beats default; a feature is off when anything it requires is off) with
 * a local filter, because `shared/` takes type-only imports from the engine (renderer CSP).
 */
export function enabledAreaIds(switches: Readonly<Record<string, boolean>>): readonly AreaId[] {
  const byId = new Map<string, FeatureDescriptor>(AREAS.map((area) => [area.id, area.feature]));
  const isOn = (id: string, seen: ReadonlySet<string>): boolean => {
    const feature = byId.get(id);
    if (feature === undefined || seen.has(id)) return false;
    if (!(switches[id] ?? feature.default)) return false;
    const next = new Set(seen).add(id);
    return feature.requires.every((required) => isOn(required, next));
  };
  return AREAS.filter((area) => isOn(area.id, new Set())).map((area) => area.id);
}

/** Narrows ids from outside (IPC) to known areas, in the order given; unknown ids are dropped. */
export function toAreaIds(ids: readonly string[]): AreaId[] {
  const known = new Set<string>(AREAS.map((area) => area.id));
  return ids.filter((id): id is AreaId => known.has(id));
}
