/**
 * Opening a Runner tab (#336): one per target, a folder, an API (any kind, a SOAP interface
 * included), a project or a sequence, named after it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import type { Selection } from '../../state/ui.js';
import { explorerRole } from '../../kinds/index.js';
import type { ExplorerNode } from '../explorer/tree-nodes.js';

export const runnerTabId = (targetId: string): string => `runner:${targetId}`;

/** The target's name where the project mirror knows it by id: a project's or a sequence's. */
export function runnerTargetName(targetId: string): string | undefined {
  const { projects, sequences } = useProjectStore.getState();
  return projects[targetId]?.name ?? sequences[targetId]?.name;
}

/** Opens (or brings forward) the Runner tab for `targetId`; `label` names it when the mirror cannot. */
export function openRunnerTab(targetId: string, label?: string): void {
  const name = runnerTargetName(targetId) ?? label;
  useEditorsStore.getState().open({
    id: runnerTabId(targetId),
    kind: 'runner',
    title: name !== undefined ? `Run ${name}` : 'Runner',
    runnerTargetId: targetId,
  });
}

/**
 * What the selected explorer row runs as: a project, a folder, a sequence, or a container row whose
 * kind names its Runner target (an API, an interface).
 */
export function runnerTargetOf(selection: Selection | undefined): string | undefined {
  if (selection === undefined) return undefined;
  if (selection.kind === 'project') return selection.id;
  if (selection.kind === 'folder') return selection.folderId;
  if (selection.kind === 'sequence') {
    return selection.id.startsWith('sequence:') ? selection.id.slice('sequence:'.length) : undefined;
  }
  // The selection carries the row's own fields, which is all a kind's `runTarget` reads.
  const node: ExplorerNode = { ...selection, kind: selection.kind as ExplorerNode['kind'], label: '' };
  return explorerRole(node.kind)?.runTarget?.(node);
}
