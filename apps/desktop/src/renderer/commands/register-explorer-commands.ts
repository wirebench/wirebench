import { catalogEntry } from '@shared/command-catalog.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { openRunnerTab, runnerTargetOf } from '../features/runner/runner-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';
import { useScriptValuesStore } from '../state/script-values.js';
import type { Selection } from '../state/ui.js';

/** Registers the `explorer.*` commands — the context menu's actions, reachable from the palette. */
export function registerExplorerCommands(): void {
  // The selected node's project, or the only project holding session values.
  registerCommand({
    ...catalogEntry('script.clearValues'),
    when: (ctx) => valuesProjectId(ctx.selection) !== undefined,
    whenScope: 'project',
    run: (ctx) => {
      explorerActions.clearValues(valuesProjectId(ctx.selection));
    },
  });
  registerCommand({
    ...catalogEntry('sequence.new'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newSequence(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('runner.open'),
    when: (ctx) => runnerTargetOf(ctx.selection) !== undefined,
    whenScope: 'selection.runnable',
    run: (ctx) => {
      const targetId = runnerTargetOf(ctx.selection);
      if (targetId !== undefined) openRunnerTab(targetId);
    },
  });
}

/**
 * The project whose session values `script.clearValues` clears: the selected node's, when it has
 * any values, or else the one project that has.
 */
function valuesProjectId(selection: Selection | undefined): string | undefined {
  const values = useScriptValuesStore.getState().byProject;
  const holding = Object.keys(values).filter((projectId) => (values[projectId]?.length ?? 0) > 0);
  const { projectOf } = useProjectStore.getState();
  const selected =
    selection === undefined
      ? undefined
      : [selection.requestId, selection.interfaceId, selection.apiId, selection.id]
          .map((id) => (id === undefined ? undefined : (projectOf[id] ?? (id in values ? id : undefined))))
          .find((id) => id !== undefined);
  if (selected !== undefined) {
    return holding.includes(selected) ? selected : undefined;
  }
  return holding.length === 1 ? holding[0] : undefined;
}
