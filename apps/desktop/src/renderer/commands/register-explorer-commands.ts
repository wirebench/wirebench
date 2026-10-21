import { catalogEntry } from '@shared/command-catalog.js';
import type { KindId } from '@shared/kinds/kind-module.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { getExplorerTree } from '../features/explorer/explorer-api.js';
import {
  activeTabTreeNodeId,
  deleteExplorerNodes,
  DUPLICABLE_KINDS,
  duplicateExplorerNodes,
  expandExplorerAll,
  explorerTargetKinds,
  explorerTargets,
  focusExplorer,
  hasExplorerTarget,
  renameExplorerTarget,
  revealActiveTab,
} from '../features/explorer/explorer-tree-actions.js';
import { openRunnerTab, runnerTargetOf } from '../features/runner/runner-actions.js';
import { kindExplorer } from '../kinds/index.js';
import type { TabContainer } from '../kinds/tab-contribution.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';
import { useScriptValuesStore } from '../state/script-values.js';
import { currentProjectId } from '../state/workspace-tabs.js';
import type { Selection } from '../state/ui.js';
import { kindTarget } from './command-helpers.js';

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
  // The current project's imported scripts, all of them, after a review.
  registerCommand({
    ...catalogEntry('script.convertAll'),
    when: () => currentProjectId() !== undefined,
    whenScope: 'project',
    run: () => {
      explorerActions.convertAllScripts(currentProjectId());
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
  registerTreeCommands();
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

/** The kinds whose APIs hold folders: where **Explorer: New Folder** can create one. */
const FOLDER_KINDS: readonly KindId[] = ['rest', 'grpc', 'websocket', 'mcp'];

/** The API (and folder) a new folder lands in: the selection's, or the active tab's, whichever kind owns it. */
function newFolderTarget(selection: Selection | undefined): TabContainer | undefined {
  for (const kind of FOLDER_KINDS) {
    if (kindExplorer(kind) === undefined) continue;
    const target = kindTarget(kind, selection);
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * The tree commands (#681): the toolbar's fold buttons, focus and reveal, and Rename / Duplicate / Delete /
 * New Folder on the selected rows or the active tab's row. Delete and F2 are their keys, and only fire
 * with focus in the tree (`keyScope`); the palette runs them from anywhere.
 */
function registerTreeCommands(): void {
  registerCommand({
    ...catalogEntry('explorer.collapseAll'),
    when: () => getExplorerTree() !== null,
    whenScope: 'explorer',
    run: () => {
      getExplorerTree()?.closeAll();
    },
  });
  registerCommand({
    ...catalogEntry('explorer.expandAll'),
    when: () => getExplorerTree() !== null,
    whenScope: 'explorer',
    run: () => {
      expandExplorerAll();
    },
  });
  registerCommand({
    ...catalogEntry('explorer.focus'),
    when: () => getExplorerTree() !== null,
    whenScope: 'explorer',
    run: () => {
      focusExplorer();
    },
  });
  registerCommand({
    ...catalogEntry('explorer.revealActiveTab'),
    when: () => activeTabTreeNodeId() !== undefined,
    whenScope: 'explorer.activeTab',
    run: () => {
      revealActiveTab();
    },
  });
  registerCommand({
    ...catalogEntry('explorer.rename'),
    when: () => hasExplorerTarget(),
    whenScope: 'explorer.target',
    run: () => {
      renameExplorerTarget();
    },
  });
  registerCommand({
    ...catalogEntry('explorer.duplicate'),
    when: () => {
      const kinds = explorerTargetKinds();
      return kinds.length > 0 && kinds.every((kind) => DUPLICABLE_KINDS.has(kind));
    },
    whenScope: 'explorer.target',
    unavailable: () =>
      hasExplorerTarget()
        ? 'Only requests, sequences and mocks can be duplicated'
        : 'Select a row in the Explorer first',
    run: () => {
      duplicateExplorerNodes(explorerTargets().map((node) => node.data));
    },
  });
  registerCommand({
    ...catalogEntry('explorer.delete'),
    when: () => hasExplorerTarget(),
    whenScope: 'explorer.target',
    run: () => {
      deleteExplorerNodes(explorerTargets().map((node) => node.data));
    },
  });
  registerCommand({
    ...catalogEntry('explorer.newFolder'),
    when: (ctx) => newFolderTarget(ctx.selection) !== undefined,
    whenScope: 'explorer.target',
    unavailable: () => 'Select an API, a folder or a request first',
    run: (ctx) => {
      const target = newFolderTarget(ctx.selection);
      explorerActions.newFolder(target?.apiId, target?.folderId);
    },
  });
}
