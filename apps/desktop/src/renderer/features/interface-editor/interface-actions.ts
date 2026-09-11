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

/**
 * Opens the viewer and its Update Definition dialog. The dialog lives in the viewer, so the
 * tab is opened first — from the explorer or the palette the viewer may not exist yet.
 */
export function updateDefinition(interfaceId: string): void {
  openInterfaceTab(interfaceId, 'overview');
  useInterfaceEditorStore.getState().setDialog(interfaceId, 'update');
}

/** Opens the viewer and its Generate Documentation dialog. */
export function generateDocumentation(interfaceId: string): void {
  openInterfaceTab(interfaceId, 'overview');
  useInterfaceEditorStore.getState().setDialog(interfaceId, 'docs');
}

/**
 * Exports the interface's whole definition bundle to a folder. There is no dialog of our own:
 * main runs the native folder picker and writes the files, and the outcome is a toast — a
 * cancelled picker says nothing at all.
 */
export async function exportDefinition(interfaceId: string): Promise<void> {
  const result = await ipc().definition.export({ interfaceId });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  if (result.value.cancelled) {
    return;
  }
  const count = result.value.files.length;
  showToast(`Exported ${String(count)} ${count === 1 ? 'document' : 'documents'} to ${result.value.dir ?? ''}`);
}

/** Where in a request envelope the user asked for the schema declaration. */
export interface DeclarationQuery {
  readonly interfaceId: string;
  readonly envelopeXml: string;
  readonly offset: number;
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
  const store = useInterfaceEditorStore.getState();
  store.selectComponent(query.interfaceId, {
    namespace: declaration.namespace,
    kind: declaration.kind,
    name: declaration.name,
    document: declaration.document,
    ...(declaration.line !== undefined ? { line: declaration.line } : {}),
  });
  // The source position is recorded (but not focused) on landing, so WSDL Content is already
  // on the declaration's line if the user switches to it — with or without "Go to source".
  store.revealSource(
    query.interfaceId,
    { location: declaration.document, ...(declaration.line !== undefined ? { line: declaration.line } : {}) },
    { focus: false },
  );
}
