import { getActiveRequestEditor, getActiveRequestPaneHandle } from '../editor/active-request-editor.js';
import { gotoLine } from '../editor/xml-language.js';
import { loadXmlFrom, saveXmlAs } from '../editor/xml-file-ops.js';
import { flipMode, flipOrientation, setEditorLayout } from '../features/request-editor/layout.js';
import { focusOtherPane } from '../features/request-editor/pane-focus.js';
import { moveToAdjacentValue } from '../features/request-editor/value-navigation.js';
import { goToSchemaDefinitionAtCursor } from '../features/request-editor/schema-navigation.js';
import { registerCommand } from '../lib/commands.js';
import { useEditorsStore } from '../state/editors.js';
import { usePreferencesStore } from '../state/preferences.js';
import { useProjectStore } from '../state/project.js';
import { activeRequestId, ui } from './command-helpers.js';

/** Registers the `editor.*` commands, which act on the mounted request editor and its tab. */
export function registerEditorCommands(): void {
  // The editor.* commands act on whatever Monaco instance is currently mounted as the request
  // editor (see `active-request-editor.ts`) — gated the same way as `request.send`/`cancel`,
  // by whether a request tab is active, since that is exactly when that editor is mounted.
  registerCommand({
    id: 'editor.formatXml',
    label: 'Format Document',
    category: 'Editor',
    // Also bound directly on the Monaco instance in `request-pane.tsx` (`FORMAT_KEYBINDING`)
    // so it works with the caret in the editor: Monaco's keybinding service consumes the
    // keystroke there, and the window-level dispatcher below only sees it when focus is
    // somewhere else in the shell. Exactly as `request.send`/`SEND_KEYBINDING` already pair up.
    shortcut: 'Mod+Shift+F',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const handle = getActiveRequestPaneHandle();
      if (handle !== undefined) {
        handle.formatAndCommit();
      }
    },
  });
  registerCommand({
    id: 'editor.goToSchemaDefinition',
    label: 'Go to Schema Definition',
    category: 'Editor',
    // F12 is bound on the Monaco instance itself (see `request-pane.tsx`); the palette entry
    // and the pane's context menu run the very same action.
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      goToSchemaDefinitionAtCursor();
    },
  });
  registerCommand({
    id: 'editor.gotoLine',
    label: 'Go to Line…',
    category: 'Editor',
    // Same reasoning as `editor.formatXml` above: Mod+G is bound on the Monaco instance itself.
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const editor = getActiveRequestEditor();
      if (editor !== undefined) {
        gotoLine(editor);
      }
    },
  });
  registerCommand({
    id: 'editor.toggleLineNumbers',
    label: 'Toggle Line Numbers',
    category: 'Editor',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      void usePreferencesStore.getState().update({ editor: { lineNumbers: !ui().editorLineNumbers } });
    },
  });
  registerCommand({
    id: 'editor.saveAs',
    label: 'Save Request As…',
    category: 'Editor',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const editor = getActiveRequestEditor();
      const text = editor?.getModel()?.getValue();
      if (text !== undefined) {
        void saveXmlAs(text);
      }
    },
  });
  registerCommand({
    id: 'editor.loadFrom',
    label: 'Load Request From…',
    category: 'Editor',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const requestId = activeRequestId();
      const editor = getActiveRequestEditor();
      const currentText = editor?.getModel()?.getValue() ?? '';
      if (requestId === undefined) {
        return;
      }
      void loadXmlFrom(currentText).then((text) => {
        if (text !== undefined) {
          useProjectStore.getState().updateRequest(requestId, { envelopeXml: text });
        }
      });
    },
  });

  registerCommand({
    id: 'editor.toggleLayoutOrientation',
    label: 'Toggle Editor Layout: Side by Side / Stacked',
    category: 'Editor',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        setEditorLayout(requestId, flipOrientation);
      }
    },
  });
  registerCommand({
    id: 'editor.toggleLayoutMode',
    label: 'Toggle Editor Layout: Split / Tabs',
    category: 'Editor',
    shortcut: 'Mod+Backslash',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        setEditorLayout(requestId, flipMode);
      }
    },
  });

  // ⌘W. Closes whichever editor tab is active; the always-present Welcome tab is not a tab in
  // the store, so with nothing else open this is simply unavailable.
  registerCommand({
    id: 'editor.closeTab',
    label: 'Close Tab',
    category: 'Editor',
    shortcut: 'Mod+W',
    when: () => useEditorsStore.getState().activeId !== undefined,
    whenScope: 'editor',
    run: () => {
      const { activeId, close } = useEditorsStore.getState();
      if (activeId !== undefined) {
        close(activeId);
      }
    },
  });

  // ⌥←/⌥→. SoapUI parity: step the caret through the envelope's element values, not its tags.
  registerCommand({
    id: 'editor.nextValue',
    label: 'Go to Next Element Value',
    category: 'Editor',
    shortcut: 'Alt+Right',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      moveToAdjacentValue('next');
    },
  });
  registerCommand({
    id: 'editor.previousValue',
    label: 'Go to Previous Element Value',
    category: 'Editor',
    shortcut: 'Alt+Left',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      moveToAdjacentValue('previous');
    },
  });

  registerCommand({
    id: 'editor.focusOtherPane',
    label: 'Focus Request / Response Editor',
    category: 'Editor',
    shortcut: 'Shift+Tab',
    when: () => activeRequestId() !== undefined,
    whenScope: 'editor.request',
    run: () => {
      focusOtherPane();
    },
  });
}
