/**
 * The entry points into the Interface editor: opening (or focusing) one interface's viewer tab,
 * and the request editor's go-to-definition, which resolves a caret offset to a schema
 * declaration in main and then opens the viewer on that component.
 */

import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { useInterfaceEditorStore, type InterfaceTabId } from './interface-editor-state.js';

/** The editor-tab id one interface's viewer uses; stable, so a second open just focuses it. */
export function interfaceTabId(interfaceId: string): string {
  return `interface:${interfaceId}`;
}

/** Opens (or focuses) the Interface editor for `interfaceId`, optionally on a given tab. */
export function openInterfaceTab(interfaceId: string, tab?: InterfaceTabId): void {
  const title = useProjectStore.getState().interfaces[interfaceId]?.name ?? 'Interface';
  if (tab !== undefined) {
    useInterfaceEditorStore.getState().setTab(interfaceId, tab);
  }
  useEditorsStore.getState().open({ id: interfaceTabId(interfaceId), kind: 'interface', title, interfaceId });
}

/** Where in a request envelope the user asked for the schema declaration. */
export interface DeclarationQuery {
  readonly interfaceId: string;
  readonly envelopeXml: string;
  readonly offset: number;
  readonly bindingName?: string;
  readonly operationName?: string;
}

/**
 * Go-to-definition: asks main which schema component the caret sits on and, when one resolves,
 * opens the interface viewer with it selected on the Schema tab. A miss is reported as a toast
 * rather than silently doing nothing — a Mod+click that lands nowhere is otherwise confusing.
 */
export async function showSchemaDeclaration(query: DeclarationQuery): Promise<void> {
  const result = await ipc().definition.declarationAt({
    interfaceId: query.interfaceId,
    envelopeXml: query.envelopeXml,
    offset: query.offset,
    ...(query.bindingName !== undefined ? { bindingName: query.bindingName } : {}),
    ...(query.operationName !== undefined ? { operationName: query.operationName } : {}),
  });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  if (result.value === null) {
    showToast('No schema declaration here');
    return;
  }
  const declaration = result.value;
  openInterfaceTab(query.interfaceId);
  useInterfaceEditorStore.getState().selectComponent(query.interfaceId, {
    namespace: declaration.namespace,
    kind: declaration.kind,
    name: declaration.name,
    document: declaration.document,
    ...(declaration.line !== undefined ? { line: declaration.line } : {}),
  });
}
