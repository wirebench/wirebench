/**
 * Postman import wrapper for backwards compatibility. Delegates to the unified ImportDialog.
 */
import { ImportDialog, nameFromSource as baseNameFromSource, type ImportDialogProps } from './import-dialog.js';

export function nameFromSource(
  source: { kind: string; [key: string]: unknown } | undefined,
  defaultName = 'Imported Collection',
): string {
  return baseNameFromSource(source, defaultName);
}
export function ImportPostmanDialog(props: ImportDialogProps) {
  return <ImportDialog initialFormat="postman" {...props} />;
}
