/**
 * **Switch on scripts…** (#63): switches on the scripts of every request under an API or folder
 * whose scripts are off — an imported Postman collection's, typically. One confirmation for the
 * lot, naming what will run; each request file records the change, so it is reviewable.
 */
import { create } from 'zustand';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';

/** How many request names the dialog lists before it says "and N more". */
const NAMES_SHOWN = 8;

interface EnableScriptsDialogState {
  /** The requests to switch on, while the dialog is open. */
  readonly requestIds: readonly string[] | undefined;
  readonly open: (requestIds: readonly string[]) => void;
  readonly close: () => void;
}

export const useEnableScriptsDialog = create<EnableScriptsDialogState>((set) => ({
  requestIds: undefined,
  open: (requestIds) => {
    set({ requestIds: requestIds.length > 0 ? requestIds : undefined });
  },
  close: () => {
    set({ requestIds: undefined });
  },
}));

/** The name of a SOAP, REST or gRPC request, by id. */
function nameOf(requestId: string): string | undefined {
  const state = useProjectStore.getState();
  return state.restRequests[requestId]?.name ?? state.grpcRequests[requestId]?.name ?? state.requests[requestId]?.name;
}

/** What the dialog says will run. */
export function enableScriptsDescription(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).map((name) => `"${name}"`);
  const more = names.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${String(more)} more` : shown.join(', ');
  const count = names.length === 1 ? 'one request' : `${String(names.length)} requests`;
  return `The scripts of ${count} will run on every send from now on: ${list}. Read them first.`;
}

/** The confirmation. Mounted once, with the explorer. */
export function EnableScriptsDialog() {
  const requestIds = useEnableScriptsDialog((state) => state.requestIds);
  const close = useEnableScriptsDialog((state) => state.close);
  const enableScripts = useProjectStore((state) => state.enableScripts);
  const names = (requestIds ?? []).map((id) => nameOf(id) ?? id);

  return (
    <ConfirmDialog
      open={requestIds !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      title="Switch on scripts?"
      description={enableScriptsDescription(names)}
      confirmLabel="Switch on"
      testId="enable-scripts-dialog"
      confirmTestId="enable-scripts-confirm"
      onConfirm={() => {
        if (requestIds === undefined) {
          return;
        }
        enableScripts(requestIds).catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : 'Could not switch the scripts on');
        });
      }}
    />
  );
}
