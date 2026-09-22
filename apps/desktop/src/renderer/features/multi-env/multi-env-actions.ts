/**
 * *Send to environments…*: which request the picker is open for, the selection remembered per
 * request for the session, the fan-out still running per request, and the send itself — which
 * opens the results in a compare tab.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { showToast } from '../../components/toast.js';
import { useDraftsStore } from '../../state/drafts.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { MAX_SEND_ENVIRONMENTS } from '../../../shared/wire-types.js';
import type { EnvSelection, PickerEnvironment } from './env-picker.js';

export type MultiEnvKind = 'soap' | 'rest';

interface MultiEnvStore {
  /** The request whose picker is open, if any. */
  readonly picker: { readonly requestId: string; readonly kind: MultiEnvKind } | undefined;
  /** The last selection sent per request; session only. */
  readonly remembered: Readonly<Record<string, EnvSelection>>;
  /** The batch id of the fan-out running per request. */
  readonly running: Readonly<Record<string, string>>;
}

export const useMultiEnvStore = create<MultiEnvStore>(() => ({ picker: undefined, remembered: {}, running: {} }));

/**
 * Why *Send to environments…* is unavailable, or `undefined` when it is not: it needs two or
 * more environments to choose from — the workspace's inside a workspace, else the project's.
 */
export function sendToEnvironmentsBlocker(environmentCount: number, inWorkspace: boolean): string | undefined {
  if (environmentCount < 2) {
    return inWorkspace
      ? 'Needs two or more environments in this workspace'
      : 'Needs two or more environments in this project';
  }
  return undefined;
}

type EnvSource = { readonly environments?: readonly { id: string; name: string; order: number }[] } | undefined;

/** `source`'s environments in order, as the picker lists them. */
function ordered(source: EnvSource): PickerEnvironment[] {
  return [...(source?.environments ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((environment) => ({ id: environment.id, name: environment.name }));
}

/**
 * The environments a request can be sent under, in order, and the active one. Inside a
 * workspace those are the workspace's — main resolves every project there through them — else
 * the request's project's own.
 */
function environmentsOf(requestId: string): {
  environments: PickerEnvironment[];
  activeId: string | undefined;
  inWorkspace: boolean;
} {
  const workspace = useWorkspaceStore.getState().workspace;
  if (workspace !== null) {
    return { environments: ordered(workspace), activeId: workspace.activeEnvironmentId, inWorkspace: true };
  }
  const state = useProjectStore.getState();
  const projectId = state.projectOf[requestId];
  const project = projectId === undefined ? undefined : state.projects[projectId];
  return { environments: ordered(project), activeId: project?.activeEnvironmentId, inWorkspace: false };
}

/** The blocker for `requestId` right now, read outside React (the command's `when`). */
export function currentBlocker(requestId: string): string | undefined {
  const { environments, inWorkspace } = environmentsOf(requestId);
  return sendToEnvironmentsBlocker(environments.length, inWorkspace);
}

/** What the button and the picker need for one request, kept current. */
export function useMultiEnvState(requestId: string): {
  readonly environments: PickerEnvironment[];
  readonly activeId: string | undefined;
  readonly blocker: string | undefined;
} {
  const project = useProjectStore((state) => {
    const projectId = state.projectOf[requestId];
    return projectId === undefined ? undefined : state.projects[projectId];
  });
  const workspace = useWorkspaceStore((state) => state.workspace);
  return useMemo(() => {
    const inWorkspace = workspace !== null;
    const environments = ordered(inWorkspace ? workspace : project);
    return {
      environments,
      activeId: inWorkspace ? workspace.activeEnvironmentId : project?.activeEnvironmentId,
      blocker: sendToEnvironmentsBlocker(environments.length, inWorkspace),
    };
  }, [project, workspace]);
}

export function openEnvPicker(requestId: string, kind: MultiEnvKind): void {
  if (currentBlocker(requestId) === undefined) {
    useMultiEnvStore.setState({ picker: { requestId, kind } });
  }
}

export function closeEnvPicker(): void {
  useMultiEnvStore.setState({ picker: undefined });
}

function requestNameOf(requestId: string, kind: MultiEnvKind): string {
  const state = useProjectStore.getState();
  return (kind === 'soap' ? state.requests[requestId]?.name : state.restRequests[requestId]?.name) ?? requestId;
}

/** The editor-tab id of a request's compare tab; one per request, replaced on every send. */
export function compareTabId(requestId: string): string {
  return `env-compare:${requestId}`;
}

/**
 * Sends `requestId` to the ticked environments, the editor's unsaved edits included, and opens
 * the results in the request's compare tab. Remembers the selection for the next picker.
 */
export async function sendToEnvironments(
  requestId: string,
  kind: MultiEnvKind,
  selection: EnvSelection,
): Promise<void> {
  if (selection.ticked.length < 2 || selection.ticked.length > MAX_SEND_ENVIRONMENTS) {
    return;
  }
  const batchId = crypto.randomUUID();
  useMultiEnvStore.setState((state) => ({
    remembered: { ...state.remembered, [requestId]: selection },
    running: { ...state.running, [requestId]: batchId },
  }));

  let payload: Parameters<ReturnType<typeof ipc>['request']['sendToEnvironments']>[0] = {
    batchId,
    requestId,
    environmentIds: [...selection.ticked],
  };
  if (kind === 'soap') {
    const draft = useProjectStore.getState().requests[requestId];
    if (draft !== undefined) {
      payload = {
        ...payload,
        soap: {
          envelopeXml: draft.envelopeXml,
          headers: Object.fromEntries(draft.headers.map((header) => [header.name, header.value])),
        },
      };
    }
  } else {
    const restDraft = useDraftsStore.getState().peekRestRequest(requestId);
    if (restDraft !== undefined) {
      payload = { ...payload, restDraft };
    }
  }

  try {
    const result = await ipc().request.sendToEnvironments(payload);
    if (useMultiEnvStore.getState().running[requestId] !== batchId) {
      return;
    }
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    const requestName = requestNameOf(requestId, kind);
    useEditorsStore.getState().openOrReplace({
      id: compareTabId(requestId),
      kind: 'env-compare',
      title: `Compare: ${requestName} across ${result.value.results.length} environments`,
      envCompare: { baselineId: selection.baseline, results: result.value.results },
    });
  } finally {
    useMultiEnvStore.setState((state) => {
      if (state.running[requestId] !== batchId) {
        return state;
      }
      const running = { ...state.running };
      delete running[requestId];
      return { running };
    });
  }
}

/** Aborts every send still running in the request's fan-out. */
export async function cancelSendToEnvironments(requestId: string): Promise<void> {
  const batchId = useMultiEnvStore.getState().running[requestId];
  if (batchId !== undefined) {
    await ipc().request.cancel({ sendId: batchId });
  }
}
