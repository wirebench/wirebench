import { getActiveRequestEditor, getActiveRequestPaneHandle } from '../editor/active-request-editor.js';
import { gotoLine } from '../editor/xml-language.js';
import { loadXmlFrom, saveXmlAs } from '../editor/xml-file-ops.js';
import { cycleEnvironment } from '../features/environments/env-switcher.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { flipMode, flipOrientation, setEditorLayout } from '../features/request-editor/layout.js';
import {
  addAttachmentsThroughPicker,
  removeSelectedAttachment,
} from '../features/request-editor/attachment-actions.js';
import { copyAsCurl, recreateRequest } from '../features/request-editor/request-actions.js';
import { goToSchemaDefinitionAtCursor } from '../features/request-editor/schema-navigation.js';
import { validateAndReport } from '../features/request-editor/validate-actions.js';
import { checkWsiForRequest, lastSendId } from '../features/request-editor/wsi-actions.js';
import { openRequestDialog } from '../features/request-editor/request-dialogs.js';
import { addWsaHeadersToEditor, removeWsaHeadersFromEditor } from '../features/request-editor/wsa-actions.js';
import { applyOutgoingWssToEditor, removeOutgoingWssFromEditor } from '../features/request-editor/wss-actions.js';
import { openPreferencesTab } from '../features/preferences/section-list.js';
import { projectActions } from '../features/welcome/project-actions.js';
import { registerCommand, resetCommands } from '../lib/commands.js';
import { useEditorsStore } from '../state/editors.js';
import { useExchangesStore } from '../state/exchanges.js';
import { usePreferencesStore } from '../state/preferences.js';
import { useProjectStore } from '../state/project.js';
import { useSecretsVisibilityStore } from '../state/secrets-visibility.js';
import { useUiStore } from '../state/ui.js';

/** The request draft behind the active editor tab, or `undefined` when none is a request tab. */
function activeRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'request')?.requestId;
}

/**
 * Registers every shell command. Called once at startup; safe to call again (it resets first)
 * so Vite's hot reload does not trip the duplicate-id guard.
 *
 * @param openPalette - Opens the command palette; owned by the shell, not the store.
 */
export function registerShellCommands(openPalette: () => void): void {
  resetCommands();
  const ui = () => useUiStore.getState();

  registerCommand({
    id: 'palette.open',
    label: 'Show All Commands',
    category: 'General',
    shortcut: 'Mod+K',
    run: openPalette,
  });

  registerCommand({
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    category: 'View',
    shortcut: 'Mod+B',
    run: () => {
      ui().toggleSidebar();
    },
  });
  registerCommand({
    id: 'view.toggleConsole',
    label: 'Toggle Console',
    category: 'View',
    shortcut: 'Mod+J',
    run: () => {
      ui().toggleConsole();
    },
  });
  registerCommand({
    id: 'view.toggleDetails',
    label: 'Toggle Details Panel',
    category: 'View',
    shortcut: 'Mod+Alt+B',
    run: () => {
      ui().toggleDetails();
    },
  });

  registerCommand({
    id: 'view.showExplorer',
    label: 'Show Explorer',
    category: 'View',
    shortcut: 'Mod+Shift+E',
    run: () => {
      ui().showSidebarView('explorer');
    },
  });
  registerCommand({
    id: 'view.showSearch',
    label: 'Show Search',
    category: 'View',
    shortcut: 'Mod+Shift+S',
    run: () => {
      ui().showSidebarView('search');
    },
  });
  registerCommand({
    id: 'view.showHistory',
    label: 'Show History',
    category: 'View',
    shortcut: 'Mod+Shift+Y',
    run: () => {
      ui().showSidebarView('history');
    },
  });
  registerCommand({
    id: 'view.showWss',
    label: 'Show WS-Security',
    category: 'View',
    run: () => {
      ui().showSidebarView('wss');
    },
  });
  registerCommand({
    id: 'view.showSettings',
    label: 'Show Settings',
    category: 'View',
    shortcut: 'Mod+Comma',
    run: () => {
      // The sidebar lists the sections; the editable forms live in the Preferences tab, so the
      // familiar ⌘, opens both rather than only revealing a table of contents.
      ui().showSidebarView('settings');
      openPreferencesTab();
    },
  });
  registerCommand({
    id: 'preferences.open',
    label: 'Open Preferences',
    category: 'General',
    run: () => {
      openPreferencesTab();
    },
  });
  registerCommand({
    id: 'view.toggleTheme',
    label: 'Toggle Light/Dark Theme',
    category: 'View',
    run: () => {
      // The persisted truth is `preferences.ui.theme`; the ui store mirrors it for rendering.
      const next = ui().theme === 'light' ? 'dark' : 'light';
      void usePreferencesStore.getState().update({ ui: { theme: next } });
    },
  });

  registerCommand({
    id: 'definition.import',
    label: 'Import WSDL…',
    category: 'Definition',
    shortcut: 'Mod+I',
    run: () => {
      ui().openImportDialog();
    },
  });
  registerCommand({
    id: 'project.new',
    label: 'New Project…',
    category: 'Project',
    shortcut: 'Mod+Shift+N',
    run: () => {
      void projectActions.newProject();
    },
  });
  registerCommand({
    id: 'project.open',
    label: 'Open Project…',
    category: 'Project',
    shortcut: 'Mod+O',
    run: () => {
      void projectActions.openProject();
    },
  });
  registerCommand({
    id: 'project.save',
    label: 'Save Project',
    category: 'Project',
    shortcut: 'Mod+S',
    when: () => useProjectStore.getState().project !== null,
    run: () => {
      void projectActions.save();
    },
  });
  registerCommand({
    id: 'project.close',
    label: 'Close Project',
    category: 'Project',
    when: () => useProjectStore.getState().project !== null,
    run: () => {
      void projectActions.close();
    },
  });

  registerCommand({
    id: 'env.switch',
    label: 'Switch Environment…',
    category: 'Environment',
    when: () => useProjectStore.getState().project !== null,
    // With no argument this opens the status bar's dropdown, which is where the choice lives.
    // The palette can also pass an environment name or id to switch straight to it.
    run: (_context, arg) => {
      if (typeof arg === 'string') {
        const { environments } = useProjectStore.getState();
        const match = environments.find((env) => env.id === arg || env.name === arg);
        if (match !== undefined) {
          void useProjectStore.getState().setActiveEnvironment(match.id);
          return;
        }
      }
      ui().setEnvSwitcherOpen(true);
    },
  });
  registerCommand({
    id: 'env.next',
    label: 'Next Environment',
    category: 'Environment',
    shortcut: 'Mod+Alt+E',
    when: () => useProjectStore.getState().environments.length > 0,
    run: () => {
      void cycleEnvironment(1);
    },
  });

  // No default shortcut: revealing credentials on screen should take a deliberate act, not a
  // key one finger-slip away.
  registerCommand({
    id: 'secrets.toggleShowSecrets',
    label: 'Toggle Show Secrets in HTTP Log',
    category: 'Secrets',
    run: () => {
      void useSecretsVisibilityStore.getState().toggle();
    },
  });

  registerCommand({
    id: 'request.send',
    label: 'Send Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
    when: () => activeRequestId() !== undefined,
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().send(requestId);
      }
    },
  });
  registerCommand({
    id: 'request.cancel',
    label: 'Cancel Request',
    category: 'Request',
    shortcut: 'Escape',
    // Escape must stay available to dialogs, menus, and the palette, so this command exists
    // only while the active request is actually in flight.
    when: () => {
      const requestId = activeRequestId();
      return requestId !== undefined && useExchangesStore.getState().byRequest[requestId]?.status === 'sending';
    },
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().cancel(requestId);
      }
    },
  });

  registerCommand({
    id: 'request.validate',
    label: 'Validate Request',
    category: 'Request',
    shortcut: 'Mod+Shift+V',
    when: () => activeRequestId() !== undefined,
    run: () => {
      const requestId = activeRequestId();
      if (requestId === undefined) {
        return;
      }
      // Flush first: the debounced envelope edit may not have reached the store yet, and
      // validating a stale copy would put markers on lines the user has already changed.
      getActiveRequestPaneHandle()?.flush();
      void validateAndReport(requestId, 'request', useProjectStore.getState().requests[requestId]?.envelopeXml);
    },
  });
  registerCommand({
    id: 'response.validate',
    label: 'Validate Response',
    category: 'Request',
    when: () => {
      const requestId = activeRequestId();
      return (
        requestId !== undefined && useExchangesStore.getState().byRequest[requestId]?.exchange?.response !== undefined
      );
    },
    run: () => {
      const requestId = activeRequestId();
      const envelopeXml =
        requestId === undefined
          ? undefined
          : useExchangesStore.getState().byRequest[requestId]?.exchange?.response?.envelopeXml;
      if (requestId === undefined || envelopeXml === undefined) {
        return;
      }
      void validateAndReport(requestId, 'response', envelopeXml);
    },
  });

  registerCommand({
    id: 'request.checkWsi',
    label: 'Check WS-I compliance',
    category: 'Request',
    // The message assertions judge bytes on the wire, so there has to be an exchange to judge.
    when: () => {
      const requestId = activeRequestId();
      return requestId !== undefined && lastSendId(requestId) !== undefined;
    },
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void checkWsiForRequest(requestId);
      }
    },
  });

  // The request.* actions the pane's context menu offers, so the palette can reach them too.
  // All of them are gated the same way as `request.send`: they act on the active request tab.
  const onActiveRequest = (run: (requestId: string) => void) => (): void => {
    const requestId = activeRequestId();
    if (requestId !== undefined) {
      run(requestId);
    }
  };

  registerCommand({
    id: 'request.recreateKeepValues',
    label: 'Request: Recreate (keep values)',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'keep-values')),
  });
  registerCommand({
    id: 'request.recreateDiscardValues',
    label: 'Request: Recreate (discard values)',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'discard-values')),
  });
  registerCommand({
    id: 'request.createEmpty',
    label: 'Request: Create Empty Envelope',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void recreateRequest(requestId, 'empty')),
  });
  registerCommand({
    id: 'request.clone',
    label: 'Request: Clone…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => {
      openRequestDialog('clone', requestId);
    }),
  });
  registerCommand({
    id: 'request.copyCurl',
    label: 'Request: Copy as cURL',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void copyAsCurl(requestId, 'posix')),
  });
  registerCommand({
    id: 'request.copyCurlPowerShell',
    label: 'Request: Copy as cURL (PowerShell)',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void copyAsCurl(requestId, 'powershell')),
  });
  registerCommand({
    id: 'request.importCurl',
    label: 'Request: Import cURL…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => {
      openRequestDialog('import-curl', requestId);
    }),
  });
  // The attachments inspector's two toolbar actions, reachable without opening the strip. Both
  // go through `attachmentActions`, so the palette and the inspector cannot drift apart.
  registerCommand({
    id: 'request.addAttachment',
    label: 'Request: Add Attachment…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void addAttachmentsThroughPicker(requestId)),
  });
  registerCommand({
    id: 'request.removeAttachment',
    label: 'Request: Remove Attachment',
    category: 'Request',
    when: () => {
      const requestId = activeRequestId();
      return requestId !== undefined && useEditorsStore.getState().selectedAttachmentFor(requestId) !== undefined;
    },
    run: onActiveRequest((requestId) => void removeSelectedAttachment(requestId)),
  });

  // The four WS-Security editor actions. Unlike the request's `wssOutgoingRef` (which applies a
  // configuration on its way to the wire), these bake a header into the envelope text itself.
  registerCommand({
    id: 'request.addWssUsernameToken',
    label: 'Request: Add WSS Username Token…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => {
      openRequestDialog('wss-username-token', requestId);
    }),
  });
  registerCommand({
    id: 'request.addWsTimestamp',
    label: 'Request: Add WS-Timestamp…',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => {
      openRequestDialog('wss-timestamp', requestId);
    }),
  });
  registerCommand({
    id: 'request.applyOutgoingWss',
    label: 'Request: Outgoing WSS → Apply to Editor',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void applyOutgoingWssToEditor(requestId)),
  });
  registerCommand({
    id: 'request.removeOutgoingWss',
    label: 'Request: Outgoing WSS → Remove',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void removeOutgoingWssFromEditor(requestId)),
  });

  // The two WS-Addressing editor actions, the counterpart of the request's saved WS-A
  // configuration: these bake the headers into the envelope text rather than applying them on
  // the way to the wire.
  registerCommand({
    id: 'request.addWsaHeaders',
    label: 'Request: WS-A Headers → Add to Editor',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void addWsaHeadersToEditor(requestId)),
  });
  registerCommand({
    id: 'request.removeWsaHeaders',
    label: 'Request: WS-A Headers → Remove',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: onActiveRequest((requestId) => void removeWsaHeadersFromEditor(requestId)),
  });

  registerCommand({
    id: 'request.showCode',
    label: 'Request: Show Code',
    category: 'Request',
    when: () => activeRequestId() !== undefined,
    run: () => {
      ui().showDetails('code');
    },
  });

  // The editor.* commands act on whatever Monaco instance is currently mounted as the request
  // editor (see `active-request-editor.ts`) — gated the same way as `request.send`/`cancel`,
  // by whether a request tab is active, since that is exactly when that editor is mounted.
  registerCommand({
    id: 'editor.formatXml',
    label: 'Format Document',
    category: 'Editor',
    // No `shortcut` here: Mod+Shift+F is bound directly on the Monaco instance in
    // `request-pane.tsx` (`FORMAT_KEYBINDING`), scoped to when the editor itself has focus.
    // The global window-level keybinding dispatcher fires Mod-based bindings even while an
    // input has focus (see `shouldIgnoreEvent`), so registering the same shortcut here too
    // would run the command twice per keystroke.
    when: () => activeRequestId() !== undefined,
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
    run: () => {
      void usePreferencesStore.getState().update({ editor: { lineNumbers: !ui().editorLineNumbers } });
    },
  });
  registerCommand({
    id: 'editor.saveAs',
    label: 'Save Request As…',
    category: 'Editor',
    when: () => activeRequestId() !== undefined,
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
    when: () => activeRequestId() !== undefined,
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        setEditorLayout(requestId, flipMode);
      }
    },
  });

  // Every explorer context-menu action is also a command, so the palette can run it against
  // whatever node is currently selected. The menu itself (context-menu.tsx) owns the actual
  // logic; these mirror the same `when` gates so the palette only lists what applies.
  registerCommand({
    id: 'explorer.importAnother',
    label: 'Explorer: Import Another WSDL…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: () => {
      explorerActions.importAnother();
    },
  });
  registerCommand({
    id: 'explorer.removeInterface',
    label: 'Explorer: Remove Interface',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: (ctx) => {
      explorerActions.removeInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.showInterface',
    label: 'Explorer: Show Interface Viewer',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: (ctx) => {
      explorerActions.showInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.copyDefinitionUrl',
    label: 'Explorer: Copy Definition URL',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: (ctx) => {
      explorerActions.copyDefinitionUrl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.newRequest',
    label: 'Explorer: New Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    run: (ctx) => {
      explorerActions.newRequest(ctx.selection?.interfaceId, ctx.selection?.bindingName, ctx.selection?.operationName);
    },
  });
  registerCommand({
    id: 'explorer.copySoapAction',
    label: 'Explorer: Copy SOAPAction',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    run: (ctx) => {
      explorerActions.copySoapAction(ctx.selection?.soapAction);
    },
  });
  registerCommand({
    id: 'explorer.openRequest',
    label: 'Explorer: Open Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.openRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.cloneRequest',
    label: 'Explorer: Clone Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.cloneRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.renameRequest',
    label: 'Explorer: Rename Request…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.renameRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.deleteRequest',
    label: 'Explorer: Delete Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.deleteRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.recreateRequest',
    label: 'Explorer: Recreate Request (keep values)',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.recreateRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.checkWsiWsdl',
    label: 'Explorer: Check WSDL WS-I compliance',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: (ctx) => {
      explorerActions.checkWsiWsdl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.copyEndpointAddress',
    label: 'Explorer: Copy Endpoint Address',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'endpoint',
    run: (ctx) => {
      explorerActions.copyEndpointAddress(ctx.selection?.address);
    },
  });
}
