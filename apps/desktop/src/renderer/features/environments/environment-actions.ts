import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/** The editor-tab id an environment opens under; stable so re-opening focuses the same tab. */
export function environmentTabId(environmentId: string): string {
  return `env:${environmentId}`;
}

/** Opens (or focuses) the editor tab for one environment. No-op for an unknown id. */
export function openEnvironmentTab(environmentId: string): void {
  const environment = useProjectStore.getState().environments.find((candidate) => candidate.id === environmentId);
  if (environment === undefined) {
    return;
  }
  useEditorsStore.getState().open({
    id: environmentTabId(environmentId),
    kind: 'environment',
    title: environment.name,
    environmentId,
  });
}

/**
 * Copies an environment: a new one named `<name> (copy)`, then a patch carrying the original's
 * endpoints and properties (both maps replace wholesale). Returns the new environment's id.
 */
export async function duplicateEnvironment(environmentId: string): Promise<string | undefined> {
  const store = useProjectStore.getState();
  const source = store.environments.find((candidate) => candidate.id === environmentId);
  if (source === undefined) {
    return undefined;
  }
  const createdId = await store.addEnvironment(`${source.name} (copy)`);
  await store.updateEnvironment(createdId, {
    endpoints: { ...source.endpoints },
    properties: { ...source.properties },
  });
  return createdId;
}
