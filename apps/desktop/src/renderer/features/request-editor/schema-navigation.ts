/**
 * Go-to-definition for the request editor: from a caret (or a Mod+click) inside the envelope to
 * the schema declaration of the element under it, shown in the Interface editor's Schema tab.
 * Main owns the resolution (`definition.declarationAt`) because the `SchemaSet` lives there.
 */

import type * as Monaco from 'monaco-editor';
import { getActiveInterfaceId, getActiveRequestEditor } from '../../editor/active-request-editor.js';
import { showSchemaDeclaration } from '../interface-editor/interface-actions.js';

/** Resolves the declaration at `position` (defaulting to the caret) of `editor`. */
export async function goToSchemaDefinition(
  editor: Monaco.editor.IStandaloneCodeEditor | undefined,
  interfaceId: string | undefined,
  position?: Monaco.IPosition | null,
): Promise<void> {
  if (editor === undefined || interfaceId === undefined) {
    return;
  }
  const model = editor.getModel();
  const at = position ?? editor.getPosition();
  if (model === null || at === null || at === undefined || typeof model.getOffsetAt !== 'function') {
    return;
  }
  await showSchemaDeclaration({
    interfaceId,
    envelopeXml: model.getValue(),
    offset: model.getOffsetAt(at),
  });
}

/** The context-menu/command entry point: acts on whichever request editor is mounted. */
export function goToSchemaDefinitionAtCursor(): void {
  void goToSchemaDefinition(getActiveRequestEditor(), getActiveInterfaceId());
}
