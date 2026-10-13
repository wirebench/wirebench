/**
 * What a snippet run remembers on this machine, per workspace: the variable values used last, the last
 * targets, and the snippets run most recently. Kept in `localStorage` like `hosts-prefs.ts`; losing it only
 * empties the forms. Values are what the user typed for declared variables: a secret is never one.
 */
import { useWorkspaceStore } from '../../../state/workspace.js';

export const SNIPPET_RUNS_KEY = 'wirebench.ssh.snippetRuns';

/** A host, a group or a tag a run targets (several-host runs). */
export interface HostTarget {
  readonly kind: 'host' | 'group' | 'tag';
  readonly id: string;
}

interface Runs {
  values: Record<string, Record<string, string>>;
  targets: Record<string, HostTarget[]>;
  recent: string[];
}

/** How many recently run snippets are remembered. */
const RECENT_LIMIT = 20;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SNIPPET_RUNS_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function strings(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

function targetsOf(v: unknown): HostTarget[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (t): t is HostTarget =>
      isRecord(t) &&
      typeof t['id'] === 'string' &&
      (t['kind'] === 'host' || t['kind'] === 'group' || t['kind'] === 'tag'),
  );
}

function read(): Runs {
  const id = useWorkspaceStore.getState().workspace?.id;
  const entry = id === undefined ? undefined : readAll()[id];
  if (!isRecord(entry)) return { values: {}, targets: {}, recent: [] };
  const values = isRecord(entry['values']) ? entry['values'] : {};
  const targets = isRecord(entry['targets']) ? entry['targets'] : {};
  return {
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, strings(v)])),
    targets: Object.fromEntries(Object.entries(targets).map(([k, v]) => [k, targetsOf(v)])),
    recent: Array.isArray(entry['recent']) ? entry['recent'].filter((s): s is string => typeof s === 'string') : [],
  };
}

export function lastValues(snippetId: string): Record<string, string> {
  return read().values[snippetId] ?? {};
}

export function lastTargets(snippetId: string): readonly HostTarget[] {
  return read().targets[snippetId] ?? [];
}

/** Most recent first. */
export function recentSnippetIds(): readonly string[] {
  return read().recent;
}

export function rememberRun(snippetId: string, values: Record<string, string>, targets: readonly HostTarget[]): void {
  const id = useWorkspaceStore.getState().workspace?.id;
  if (id === undefined) return;
  const runs = read();
  runs.values[snippetId] = { ...values };
  runs.targets[snippetId] = [...targets];
  runs.recent = [snippetId, ...runs.recent.filter((s) => s !== snippetId)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(SNIPPET_RUNS_KEY, JSON.stringify({ ...readAll(), [id]: runs }));
  } catch {
    // A full or blocked storage only costs the remembered values.
  }
}
