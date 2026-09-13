/**
 * The Import cURL dialog for the entry points that are not an editor tab.
 *
 * A request editor knows its own target and mounts the dialog itself. The palette and an explorer row
 * do not, so they put a target in the UI store and this — mounted once by the shell — opens on it.
 * One place decides the label, so "imports into…" reads the same however the dialog was reached.
 */
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { ImportCurlDialog } from './import-curl-dialog.js';

/** Mounted by the shell; open exactly when a target has been set. */
export function ImportCurlFromTarget() {
  const target = useUiStore((state) => state.importCurlTarget);
  const setTarget = useUiStore((state) => state.setImportCurlTarget);
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
        if (!next) {
          setTarget(undefined);
        }
      }}
      target={target}
      targetLabel={label}
    />
  );
}
