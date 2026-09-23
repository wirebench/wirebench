import type { EditorTab } from '../../state/editors.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';

/** The entity an editor tab shows, by whichever id field its kind sets. */
function tabEntityId(tab: EditorTab): string | undefined {
  return (
    tab.requestId ??
    tab.restRequestId ??
    tab.grpcRequestId ??
    tab.wsRequestId ??
    tab.apiId ??
    tab.grpcApiId ??
    tab.wsApiId ??
    tab.interfaceId ??
    tab.projectId ??
    tab.environmentId
  );
}

/**
 * The project *Set Secret Token Value…* opens on: the one the active tab belongs to, else the
 * first open project (the only one, when there is one). `undefined` with no project open. With
 * several open the dialog offers the others, so a wrong guess is one choice away.
 */
export function secretTokenProjectId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  const { projects, projectOf, order } = useProjectStore.getState();
  const active = tabs.find((tab) => tab.id === activeId);
  const entity = active === undefined ? undefined : tabEntityId(active);
  const owner = entity === undefined ? undefined : projectOf[entity];
  if (owner !== undefined && projects[owner] !== undefined) {
    return owner;
  }
  return order.map((entry) => entry.projectId).find((id) => projects[id] !== undefined) ?? Object.keys(projects)[0];
}

/**
 * Opens the Secret token values dialog on `projectId` (default: {@link secretTokenProjectId}),
 * with `name`'s row ready for its value when one is given. A no-op with no project to open it on.
 */
export function openSecretTokenDialog(projectId = secretTokenProjectId(), name?: string): void {
  if (projectId === undefined) {
    return;
  }
  useUiStore.getState().setSecretTokenDialog(name === undefined ? { projectId } : { projectId, name });
}
