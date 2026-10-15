/**
 * The Import cURL dialog for the entry points that are not an editor tab.
 *
 * A request editor knows its own target and mounts the dialog itself. The palette and an explorer row
 * do not, so they put a target in the UI store and this — mounted once by the shell — opens on it.
 * One place decides the label, so "imports into…" reads the same however the dialog was reached.
 */
import { useRef } from 'react';
import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { ImportCurlDialog } from './import-curl-dialog.js';

/** Mounted by the shell; open exactly when a target has been set. */
export function ImportCurlFromTarget() {
  const target = useUiStore((state) => state.importCurlTarget);
  const setTarget = useUiStore((state) => state.setImportCurlTarget);
  // Whether this opening of the dialog imported anything: a provisional API is kept only then.
  const imported = useRef(false);
  const apiName = useProjectStore((state) => (target?.kind === 'rest' ? state.apis[target.apiId]?.name : undefined));
  const folderName = useProjectStore((state) =>
    target?.kind === 'rest' && target.folderId !== undefined ? state.folders[target.folderId]?.name : undefined,
  );

  if (target === undefined) {
    return null;
  }
  const label =
    target.kind === 'soap'
      ? `the ${target.operationName} operation`
      : folderName !== undefined
        ? `the folder “${folderName}”`
        : apiName === undefined
          ? 'this API'
          : `the API “${apiName}”`;

  return (
    <ImportCurlDialog
      open
      onOpenChange={(next) => {
        if (next) {
          return;
        }
        const provisional = useUiStore.getState().importCurlProvisionalApiId;
        const keep = imported.current;
        imported.current = false;
        setTarget(undefined);
        if (provisional !== undefined && !keep) {
          void useProjectStore
            .getState()
            .removeApi(provisional)
            .catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : 'Removing the empty API failed');
            });
        }
      }}
      onImported={() => {
        imported.current = true;
      }}
      target={target}
      targetLabel={label}
    />
  );
}
