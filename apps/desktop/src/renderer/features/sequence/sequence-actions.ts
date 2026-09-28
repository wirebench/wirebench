/**
 * Opening a sequence's tab. The id, `sequence:<sequenceId>`, is fixed here because the explorer, the
 * persisted-tab restore and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id for one sequence. */
export function sequenceTabId(sequenceId: string): string {
  return `sequence:${sequenceId}`;
}

/** Opens (or focuses) the sequence's tab. A sequence the mirror does not hold is ignored. */
export function openSequenceTab(sequenceId: string, fallbackTitle?: string): void {
  const title = useProjectStore.getState().sequences[sequenceId]?.name ?? fallbackTitle;
  if (title === undefined) {
    return;
  }
  useEditorsStore.getState().open({ id: sequenceTabId(sequenceId), kind: 'sequence', title, sequenceId });
}
