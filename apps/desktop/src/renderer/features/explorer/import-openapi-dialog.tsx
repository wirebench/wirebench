/**
 * OpenAPI import wrapper for backwards compatibility. Delegates to the unified ImportDialog.
 */
import { ImportDialog, nameFromSource, type ImportDialogProps } from './import-dialog.js';

export { nameFromSource };
export function ImportOpenApiDialog(props: ImportDialogProps) {
  return <ImportDialog initialFormat="openapi" {...props} />;
}
