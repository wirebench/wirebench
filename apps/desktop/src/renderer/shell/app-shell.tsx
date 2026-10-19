import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Loader2 } from 'lucide-react';
import { SecretReviewDialog } from '../components/secret-review-dialog.js';
import { SignInDialog } from '../features/account/sign-in-dialog.js';
import { TeamDialog } from '../features/team/team-dialog.js';
import { WebhooksDialogs } from '../features/webhooks/webhooks-dialogs.js';
import { SchedulesDialogs } from '../features/schedules/schedules-dialogs.js';
import { ImportWebhooksDialog } from '../features/webhook-items/import-webhooks-dialog.js';
import { SaveAsWebhookDialog } from '../features/webhook-items/save-as-webhook-dialog.js';
import { WebhookSettingsDialog } from '../features/webhook-items/webhook-settings-dialog.js';
import { subscribeToAccounts, useAccountStore } from '../state/account.js';
import { ToastViewport } from '../components/toast.js';
import { toAreaIds } from '@shared/area-module.js';
import { toKindId, type KindId } from '@shared/kinds/kind-module.js';
import { ipc } from '../state/ipc-client.js';
import { registerShellCommands } from '../commands/register-shell-commands.js';
import type { CommandContext } from '../lib/commands.js';
import { runCommand } from '../lib/commands.js';
import { useKeybindings } from '../lib/keybindings.js';
import { detectPlatform } from '../lib/platform.js';
import { useTheme } from '../lib/theme.js';
import { hydrateUi, useUiStore } from '../state/ui.js';
import { useEditorsStore } from '../state/editors.js';
import { rememberFocusedProject, rememberOpenWorkspaceTabs } from '../state/workspace-tabs.js';
import { subscribeToGlobals } from '../state/globals.js';
import { subscribeToCertificateExpiry } from '../state/certificate-expiry.js';
import { syncTabSetsWithSidebar } from '../state/tab-set-sync.js';
import { subscribeToCurrentValues } from '../state/current-values.js';
import { subscribeToScriptValues } from '../state/script-values.js';
import { subscribeToPreferences, usePreferencesStore } from '../state/preferences.js';
import { subscribeToHistory } from '../state/history.js';
import {
  subscribeToExchangeFailures,
  subscribeToExchangeLogged,
  subscribeToSecretsVisibility,
  subscribeToGrpcLive,
  subscribeToRestLive,
  subscribeToWsLive,
  subscribeToMcpLive,
} from '../state/exchanges.js';
import { useDraftsStore } from '../state/drafts.js';
import { subscribeToProject, useProjectStore } from '../state/project.js';
import { subscribeToWorkspace, useWorkspaceStore } from '../state/workspace.js';
import { subscribeToSync } from '../state/sync.js';
import { subscribeToHosts } from '../features/ssh/hosts-store.js';
import { collapseConsoleInShortWindow, subscribeConsoleToFirstSend } from '../state/console-first-send.js';
import {
  subscribeToSnippets,
  useSnippetEditorShown,
  useSnippetsStore,
} from '../features/ssh/snippets/snippets-store.js';
import { subscribeToSshEvents } from '../features/ssh/terminal-session.js';
import { subscribeToShareEvents, useTerminalShareStore } from '../features/ssh/terminal-share-store.js';
import { useSessionLogsDialogStore, useTeamSessionLogsDialogStore } from '../features/ssh/session-logs-store.js';
import { useRunDialogStore } from '../features/ssh/snippets/run.js';
import { useHostDelete } from '../features/ssh/host-delete-store.js';
import { subscribeToForwards } from '../features/ssh/forwarding/forwards-store.js';
import { subscribeToTeamSecrets } from '../state/team-secrets.js';
import { subscribeToWebhooks } from '../state/webhooks.js';
import { subscribeToSchedules } from '../state/schedules.js';
import { WorkspacePicker } from '../features/workspace/picker-screen.js';
import { NewProjectDialog } from '../features/workspace/new-project-dialog.js';
import { CreateWorkspaceDialog } from '../features/workspace/create-workspace-dialog.js';
import { SettingsPage } from '../features/preferences/settings-page.js';
import { WorkspaceManageDialog } from '../features/workspace/manage-dialog.js';
import { RemoveProjectDialog } from '../features/workspace/remove-project-dialog.js';
import { RevealSecretsDialog } from '../features/console/reveal-secrets-dialog.js';
import { UnsavedCloseDialog } from './unsaved-close-dialog.js';
import { ShareDialog } from '../features/workspace/share-dialog.js';
import { JoinDialog } from '../features/workspace/join-dialog.js';
import { OpenTeamWorkspaceDialog } from '../features/workspace/open-team-workspace-dialog.js';
import { MoveProjectDialog } from '../features/explorer/move-project-dialog.js';
import { SecretSourcesApproveDialog } from '../features/secret-sources/approve-dialog.js';
import { SecretSourcesDialog } from '../features/secret-sources/secret-sources-dialog.js';
import { CollectionExportReportDialog } from '../features/explorer/export-collection.js';
import { SecretTokenDialog } from '../features/secrets/secret-token-dialog.js';
import { SyncPanel } from '../features/sync/sync-panel.js';
import { ConflictResolver } from '../features/sync/conflict-resolver.js';
import { McpApprovalDialog } from '../features/mcp-editor/approval-dialog.js';
import { IdentityDialog } from '../features/sync/identity-dialog.js';
import { ActivityBar } from './activity-bar.js';
import { subscribeToMenuCommands, syncAppMenu } from './app-menu.js';
import { CodePanel } from './code-panel.js';
import { slideOverWidthOf } from '../state/ui-state.js';
import { useForwardDetailsShown, useHostDetailsShown } from '../features/ssh/details-shown.js';
import { useForwardsStore } from '../features/ssh/forwarding/forwards-store.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import { CommandPalette } from './command-palette.js';
import type { PaletteMode } from './command-palette.js';
import { ConsolePanel } from './console-panel.js';
import { EditorArea } from './editor-area.js';
import { ImportDialog } from '../features/explorer/import-dialog.js';
import { FolderAuthDialog } from '../features/rest-api/folder-auth-dialog.js';
import { FolderScriptsDialog } from '../features/scripts/folder-scripts-dialog.js';
import { ImportCurlFromTarget } from '../features/request-editor/import-curl-from-target.js';
import { PanelHandle } from './panel-handle.js';
import {
  EnvironmentDetailsPanel,
  environmentDetailsOpen,
  setEnvironmentDetailsOpen,
  useEnvironmentDetailsShown,
} from '../features/environments/environment-details.js';
import { rightPanelFor } from './right-panel.js';
import { RightRail } from './right-rail.js';
import { Sidebar } from './sidebar.js';
import { SlideOver } from './slide-over.js';
import { StatusBar } from './status-bar.js';
import { TitleBar } from './title-bar.js';
import { subscribeToMocks } from '../state/mock-runs.js';
import { subscribeToRunnerProgress } from '../state/runner.js';
import { subscribeToSequenceProgress } from '../state/sequence-runs.js';

/** The sidebar's size bounds, as a percentage of the row it shares with the editor/console column. */
const SIDEBAR_MIN = 12;
const SIDEBAR_MAX = 40;
/** The console's size bounds, as a percentage of the column it shares with the editor area. */
const CONSOLE_MIN = 10;
const CONSOLE_MAX = 70;
/** Arrow-key resize step for both, per the layout plan's §4. */
const PANEL_STEP = 2;

/**
 * Resizes (or, past `min`, collapses) a percentage-sized panel. Shared by the sidebar and the
 * console: both read their live state from the store directly (rather than a closed-over prop)
 * so a fast sequence of drag deltas — each one only the pixels moved since the last — always
 * builds on the size the previous delta actually produced.
 */
function resizePercentPanel(
  next: number,
  min: number,
  max: number,
  collapse: () => void,
  setSize: (size: number) => void,
): void {
  if (next < min) {
    collapse();
  } else {
    setSize(Math.min(max, next));
  }
}

/**
 * The IDE shell: title bar, activity bar, sidebar, editor area, console, right rail (with its
 * Code slide-over), status bar. Owns the palette's open state and the one keydown listener;
 * every region below is presentational.
 */
// Split out: its script field is Monaco, which only ever loads with an editor.
const SnippetEditor = lazy(async () => {
  const module = await import('../features/ssh/snippets/snippet-editor.js');
  return { default: module.SnippetEditor };
});

// The SSH panels and dialogs below load the first time one shows, not before the first paint: the
// window opens on whichever area was last in front, and most of them sit behind a click.
const HostDetails = lazy(async () => {
  const module = await import('../features/ssh/host-details.js');
  return { default: module.HostDetails };
});
const ForwardDetails = lazy(async () => {
  const module = await import('../features/ssh/forwarding/forward-details.js');
  return { default: module.ForwardDetails };
});
const TrustDialog = lazy(async () => {
  const module = await import('../features/ssh/trust-dialog.js');
  return { default: module.TrustDialog };
});
const HostDeleteDialog = lazy(async () => {
  const module = await import('../features/ssh/host-delete.js');
  return { default: module.HostDeleteDialog };
});
const ForwardPrompts = lazy(async () => {
  const module = await import('../features/ssh/forwarding/bind-confirm-dialog.js');
  return { default: module.ForwardPrompts };
});
const SnippetRunDialog = lazy(async () => {
  const module = await import('../features/ssh/snippets/run-dialog.js');
  return { default: module.SnippetRunDialog };
});
const SessionLogsDialog = lazy(async () => {
  const module = await import('../features/ssh/session-logs.js');
  return { default: module.SessionLogsDialog };
});
const JoinShareDialog = lazy(async () => {
  const module = await import('../features/ssh/join-share-dialog.js');
  return { default: module.JoinShareDialog };
});

const TeamSessionLogsDialog = lazy(async () => {
  const module = await import('../features/ssh/team-session-logs.js');
  return { default: module.TeamSessionLogsDialog };
});

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const platform = useMemo(() => detectPlatform(), []);

  const sidebar = useUiStore((state) => state.sidebar);
  const consoleState = useUiStore((state) => state.console);
  // The console's tabs (problems, HTTP log, WS-I) are about requests: the SSH area has none, so it
  // gets the full height. Its open/closed state, size and tab are kept for the other areas.
  const consoleShown = useUiStore((state) => state.sidebar.view !== 'ssh');
  const slideOver = useUiStore((state) => state.slideOver);
  // Each area keeps its own slide-over width.
  const slideOverWidth = useUiStore(slideOverWidthOf);
  const theme = useUiStore((state) => state.theme);
  const sshEnabled = useUiStore((state) => state.enabledAreas.includes('ssh'));
  const editorLineNumbers = useUiStore((state) => state.editorLineNumbers);
  const editorLayout = useUiStore((state) => state.editorLayout);
  const selection = useUiStore((state) => state.selection);
  const setSlideOverWidth = useUiStore((state) => state.setSlideOverWidth);
  const toggleCode = useUiStore((state) => state.toggleCode);
  const closeCode = useUiStore((state) => state.closeCode);
  // On the Hosts tab the slide-over holds the picked host instead of a request's code.
  const hostDetailsShown = useHostDetailsShown();
  // Code is only for the areas with requests (`right-panel.ts`).
  const codeArea = useEditorsStore((state) => rightPanelFor(state) === 'code');
  const settingsOpen = useUiStore((state) => state.preferences.open);
  // While New host borrows the panel, the handle's double-click puts it away like the close icon.
  const newHostOpen = useHostsStore((state) => state.dialog?.mode === 'new-host');
  const editHostOpen = useHostsStore((state) => state.dialog?.mode === 'edit-host');
  const toggleHostDetails = useCallback(() => {
    const hosts = useHostsStore.getState();
    hosts.setDetailsOpen(hosts.dialog?.mode !== 'new-host' && useUiStore.getState().slideOver.hostDetailsOpen !== true);
  }, []);
  const closeHostDetails = useCallback(() => {
    useHostsStore.getState().setDetailsOpen(false);
  }, []);
  // On the Port forwarding view it holds the picked forward.
  const forwardDetailsShown = useForwardDetailsShown();
  const closeForwardDetails = useCallback(() => {
    useForwardsStore.getState().setDetailsOpen(false);
  }, []);
  // In the Environments area it holds the open environment's colour and Applies to.
  const environmentDetailsShown = useEnvironmentDetailsShown();
  const closeEnvironmentDetails = useCallback(() => {
    setEnvironmentDetailsOpen(false);
  }, []);
  const toggleEnvironmentDetails = useCallback(() => {
    setEnvironmentDetailsOpen(!environmentDetailsOpen());
  }, []);
  // On the Snippets view it holds the snippet being edited.
  const snippetEditorShown = useSnippetEditorShown();
  const closeSnippetEditor = useCallback(() => {
    useSnippetsStore.getState().closeEditor();
  }, []);
  const importDialogOpen = useUiStore((state) => state.importDialogOpen);
  // The SSH dialogs mount only while they ask something, so their code loads on the first ask.
  const trustAsked = useHostsStore((state) => state.trustPrompt !== null);
  const hostDeleteAsked = useHostDelete((state) => state.hostId !== null);
  const forwardAsked = useForwardsStore((state) => state.bindPrompt !== null || state.portPrompt !== null);
  const snippetRunAsked = useRunDialogStore((state) => state.request !== null);
  const sessionLogsOpen = useSessionLogsDialogStore((state) => state.open);
  const teamSessionLogsOpen = useTeamSessionLogsDialogStore((state) => state.open);
  const joinShareOpen = useTerminalShareStore((state) => state.joinOpen);
  const closeImportDialog = useUiStore((state) => state.closeImportDialog);

  // The row the sidebar and the editor/console column share, and the column the editor area and
  // the console share — measured on drag so a pixel delta can be turned into a percentage of the
  // space it actually resizes.
  const rowRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);

  // How far a collapsed panel's handle has been dragged back out, in pixels. A collapsed panel
  // has no size to add a delta to, so the outward drag is accumulated here until it amounts to
  // the panel's minimum share — which is what makes the reopen the mirror image of the collapse,
  // and stops the small jitter inside a double-click from reopening what it just shut. Reset when
  // the gesture ends, so a drag that never reached the minimum does not carry into the next one.
  const sidebarReopenPx = useRef(0);
  const consoleReopenPx = useRef(0);

  const dragSidebar = useCallback((deltaPx: number) => {
    const width = rowRef.current?.clientWidth;
    if (width === undefined || width === 0) {
      return;
    }
    const store = useUiStore.getState();
    if (!store.sidebar.visible) {
      // Spec §4: "dragging the handle back out reopens it".
      sidebarReopenPx.current = Math.max(0, sidebarReopenPx.current + deltaPx);
      const reopenAt = (sidebarReopenPx.current / width) * 100;
      if (reopenAt >= SIDEBAR_MIN) {
        sidebarReopenPx.current = 0;
        store.expandSidebar();
        store.setSidebarSize(Math.min(SIDEBAR_MAX, reopenAt));
      }
      return;
    }
    const next = store.sidebar.size + (deltaPx / width) * 100;
    resizePercentPanel(next, SIDEBAR_MIN, SIDEBAR_MAX, store.collapseSidebar, store.setSidebarSize);
  }, []);

  // A gesture that ended without reopening the panel starts the next one from zero again.
  const endSidebarDrag = useCallback(() => {
    sidebarReopenPx.current = 0;
  }, []);

  const endConsoleDrag = useCallback(() => {
    consoleReopenPx.current = 0;
  }, []);

  const stepSidebar = useCallback((direction: 1 | -1) => {
    const store = useUiStore.getState();
    if (!store.sidebar.visible) {
      return;
    }
    resizePercentPanel(
      store.sidebar.size + direction * PANEL_STEP,
      SIDEBAR_MIN,
      SIDEBAR_MAX,
      store.collapseSidebar,
      store.setSidebarSize,
    );
  }, []);

  // The handle sits above the console: dragging (or stepping) down shrinks it, up grows it.
  const dragConsole = useCallback((deltaPx: number) => {
    const height = columnRef.current?.clientHeight;
    if (height === undefined || height === 0) {
      return;
    }
    const store = useUiStore.getState();
    if (!store.console.visible) {
      // The handle sits above the console, so dragging *up* — a negative delta — is the outward
      // direction that reopens it, the mirror of the downward drag that shut it.
      consoleReopenPx.current = Math.max(0, consoleReopenPx.current - deltaPx);
      const reopenAt = (consoleReopenPx.current / height) * 100;
      if (reopenAt >= CONSOLE_MIN) {
        consoleReopenPx.current = 0;
        store.expandConsole();
        store.setConsoleSize(Math.min(CONSOLE_MAX, reopenAt));
      }
      return;
    }
    const next = store.console.size - (deltaPx / height) * 100;
    resizePercentPanel(next, CONSOLE_MIN, CONSOLE_MAX, store.collapseConsole, store.setConsoleSize);
  }, []);

  const stepConsole = useCallback((direction: 1 | -1) => {
    const store = useUiStore.getState();
    if (!store.console.visible) {
      return;
    }
    resizePercentPanel(
      store.console.size - direction * PANEL_STEP,
      CONSOLE_MIN,
      CONSOLE_MAX,
      store.collapseConsole,
      store.setConsoleSize,
    );
  }, []);

  // What double-clicking the sidebar/console handle does: collapse an expanded panel (remembering
  // its size as `lastSize`), or restore a collapsed one to that remembered size — the product
  // owner's "double-click the handle to collapse or restore". Read live from the store, the same
  // way the drag/step callbacks above do, since these are stable identities registered once.
  const onDoubleClickSidebarHandle = useCallback(() => {
    const store = useUiStore.getState();
    if (store.sidebar.visible) {
      store.collapseSidebar();
    } else {
      store.expandSidebar();
    }
  }, []);

  const onDoubleClickConsoleHandle = useCallback(() => {
    const store = useUiStore.getState();
    if (store.console.visible) {
      store.collapseConsole();
    } else {
      store.expandConsole();
    }
  }, []);

  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaceReady = useWorkspaceStore((state) => state.ready);
  // The title bar's dot means "something is unsaved": any open project will do.
  const projectDirty = useProjectStore((state) => Object.values(state.projects).some((project) => project.dirty));
  // Staged edits count too. A tab can be closed while its edit is still unsaved — the draft
  // outlives the tab, so without this the only indicator of it would have disappeared with the
  // tab that showed the dot.
  const staged = useDraftsStore((state) => Object.keys(state.requests).length > 0);
  const dirty = projectDirty || staged;

  useEffect(() => {
    hydrateUi();
  }, []);

  // The layout is written to `localStorage` on every change, but the open workspace's *tabs*
  // are recorded only when a workspace is left for another one. Closing the window is the
  // other way they can go, so record them on the way out too; the write is synchronous, which
  // is what makes it safe to do this late.
  useEffect(() => {
    const remember = (): void => {
      rememberOpenWorkspaceTabs();
    };
    window.addEventListener('pagehide', remember);
    return () => {
      window.removeEventListener('pagehide', remember);
    };
  }, []);

  useEffect(() => subscribeToWorkspace(), []);
  useEffect(() => subscribeToSync(), []);
  useEffect(() => subscribeToTeamSecrets(), []);
  useEffect(() => subscribeToHosts(), []);
  useEffect(() => subscribeConsoleToFirstSend(), []);
  useEffect(() => collapseConsoleInShortWindow(), []);
  // The `forward.*` channels exist only while the SSH area is on.
  useEffect(() => (sshEnabled ? subscribeToForwards() : undefined), [sshEnabled]);
  useEffect(() => subscribeToSnippets(), []);
  useEffect(() => subscribeToSshEvents(), []);
  useEffect(() => subscribeToShareEvents(), []);
  useEffect(() => subscribeToWebhooks(), []);
  useEffect(() => subscribeToSchedules(), []);
  useEffect(() => subscribeToAccounts(), []);
  useEffect(() => {
    void useAccountStore.getState().load();
  }, []);
  useEffect(() => subscribeToProject(), []);
  useEffect(() => subscribeToGlobals(), []);
  useEffect(() => subscribeToCertificateExpiry(), []);
  // Each activity-bar area shows its own set of editor tabs.
  useEffect(() => syncTabSetsWithSidebar(), []);
  // The current project (#468) outlives focusing a tab that names none.
  useEffect(() => rememberFocusedProject(), []);
  useEffect(() => subscribeToCurrentValues(), []);
  useEffect(() => subscribeToScriptValues(), []);
  useEffect(() => subscribeToPreferences(), []);
  useEffect(() => subscribeToHistory(), []);
  useEffect(() => subscribeToExchangeFailures(), []);
  useEffect(() => subscribeToExchangeLogged(), []);
  useEffect(() => subscribeToSecretsVisibility(), []);
  useEffect(() => subscribeToGrpcLive(), []);
  useEffect(() => subscribeToRestLive(), []);
  useEffect(() => subscribeToWsLive(), []);
  useEffect(() => subscribeToMcpLive(), []);
  useEffect(() => subscribeToSequenceProgress(), []);
  useEffect(() => subscribeToRunnerProgress(), []);
  useEffect(() => subscribeToMocks(), []);

  const openPalette = useCallback((mode: PaletteMode = 'commands') => {
    setPaletteMode(mode);
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    registerShellCommands(openPalette);
    // The manifest is built from the registry, so it can only be sent once registration ran.
    void syncAppMenu();
    // Main knows which areas this run switched off; register again without their commands.
    void ipc()
      .app.areas(undefined)
      .then((result) => {
        if (cancelled || !result.ok) return;
        useUiStore.getState().setEnabledAreas(toAreaIds(result.value.enabled));
        useUiStore.getState().setLocalTerminalEnabled(result.value.localTerminal);
        useUiStore.getState().setTelnetEnabled(result.value.telnet ?? true);
        useUiStore.getState().setSerialEnabled(result.value.serial ?? true);
        registerShellCommands(openPalette); // resetCommands() at its top makes re-registration safe
        void syncAppMenu();
      });
    // And which kinds; a kind that is off registers no commands, and its containers show as placeholders.
    void ipc()
      .app.kinds(undefined)
      .then((result) => {
        if (cancelled || !result.ok) return;
        useUiStore
          .getState()
          .setEnabledKinds(result.value.enabled.map(toKindId).filter((kind): kind is KindId => kind !== undefined));
        registerShellCommands(openPalette);
        void syncAppMenu();
      });
    return () => {
      cancelled = true;
    };
  }, [openPalette]);

  useTheme(theme);

  const context: CommandContext = useMemo(
    () => ({
      platform,
      ui: { sidebar, console: consoleState, slideOver, theme, editorLineNumbers, editorLayout },
      selection,
    }),
    [platform, sidebar, consoleState, slideOver, theme, editorLineNumbers, editorLayout, selection],
  );
  useKeybindings(context);

  // `command.invoke` outlives every context change, so the subscription reads the latest
  // context through a ref rather than re-subscribing on each selection or panel toggle.
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => subscribeToMenuCommands(() => contextRef.current), []);

  // A rebind changes the accelerators the OS menu shows, so the manifest is pushed again
  // whenever the override map does.
  const shortcuts = usePreferencesStore((state) => state.preferences.shortcuts);
  useEffect(() => {
    void syncAppMenu();
  }, [shortcuts]);

  const dispatch = useCallback(
    (id: Parameters<typeof runCommand>[0]) => () => {
      void runCommand(id, context);
    },
    [context],
  );

  return (
    <TooltipPrimitive.Provider delayDuration={400}>
      <div className="flex h-full flex-col bg-surface-base text-fg-default">
        <TitleBar
          platform={platform}
          workspaceName={workspace?.name ?? null}
          dirty={dirty}
          onOpenPalette={openPalette}
          onToggleTheme={dispatch('view.toggleTheme')}
        />

        {/* Settings takes the place of everything between the title bar and the status bar
            while it is open. The workbench stays mounted underneath, only hidden, so editors,
            terminals and scroll positions are exactly as they were when Settings closes. */}
        {settingsOpen && <SettingsPage />}
        <div className={settingsOpen ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
          {/* The title bar stays above the picker: it carries the window controls on every
            platform, and losing them with no workspace open would trap the user. */}
          {workspace === null && !workspaceReady ? (
            // Main answers the first snapshot only once its launch-time reopen settled; until
            // then neither the picker nor the IDE is known to be right, so neither is shown.
            <div
              data-testid="workspace-loading"
              role="status"
              aria-live="polite"
              className="flex min-h-0 flex-1 items-center justify-center"
            >
              <Loader2 size={24} aria-hidden="true" className="animate-spin text-fg-muted" />
              <span className="sr-only">Opening the last workspace…</span>
            </div>
          ) : workspace === null ? (
            <div className="min-h-0 flex-1">
              <WorkspacePicker />
            </div>
          ) : (
            <div className="relative flex min-h-0 flex-1">
              <ActivityBar platform={platform} />

              <div ref={rowRef} className="flex min-w-0 flex-1">
                {sidebar.visible && (
                  <div
                    data-testid="sidebar-panel"
                    style={{ width: `${String(sidebar.size)}%` }}
                    className="min-w-0 shrink-0 border-r border-hairline"
                  >
                    <Sidebar />
                  </div>
                )}
                {/* The handle stays mounted (and hit-testable) even while the sidebar is collapsed,
                  so a double-click on it — expand or collapse — and a drag back out always have a
                  target; only the panel's own content unmounts. */}
                <PanelHandle
                  testId="panel-handle-sidebar"
                  label={sidebar.visible ? 'Resize Sidebar' : 'Show Sidebar'}
                  orientation="vertical"
                  valueNow={sidebar.visible ? sidebar.size : 0}
                  valueMin={SIDEBAR_MIN}
                  valueMax={SIDEBAR_MAX}
                  onDrag={dragSidebar}
                  onDragEnd={endSidebarDrag}
                  onStep={stepSidebar}
                  onDoubleClick={onDoubleClickSidebarHandle}
                />

                <div ref={columnRef} data-testid="main-panel" className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="min-h-0 min-w-0 flex-1">
                    <EditorArea />
                  </div>
                  {/* Same rationale as the sidebar's handle above: stays mounted while the console
                    is collapsed (outside the SSH area, which has no console at all). */}
                  {consoleShown && (
                    <PanelHandle
                      testId="panel-handle-console"
                      label={consoleState.visible ? 'Resize Console' : 'Show Console'}
                      orientation="horizontal"
                      valueNow={consoleState.visible ? consoleState.size : 0}
                      valueMin={CONSOLE_MIN}
                      valueMax={CONSOLE_MAX}
                      onDrag={dragConsole}
                      onDragEnd={endConsoleDrag}
                      onStep={stepConsole}
                      onDoubleClick={onDoubleClickConsoleHandle}
                    />
                  )}
                  {consoleShown && consoleState.visible && (
                    <div
                      data-testid="console-panel"
                      style={{ height: `${String(consoleState.size)}%` }}
                      className="min-h-0 shrink-0"
                    >
                      <ConsolePanel />
                    </div>
                  )}
                </div>
                {/* The right panel shares this row with the sidebar and the editor: opening it narrows
                  the editor (the row, and so the sidebar's share, stay the same width). While closed it
                  unmounts completely; the rail's icon or `view.toggleCode` reopens it. */}
                <SlideOver
                  label="Code"
                  open={slideOver.open && codeArea && !settingsOpen}
                  width={slideOverWidth}
                  onWidthChange={setSlideOverWidth}
                  onToggle={toggleCode}
                  onClose={closeCode}
                >
                  <CodePanel />
                </SlideOver>
                <SlideOver
                  label={newHostOpen ? 'New host' : editHostOpen ? 'Edit host' : 'Host details'}
                  open={hostDetailsShown && !settingsOpen}
                  width={slideOverWidth}
                  onWidthChange={setSlideOverWidth}
                  onToggle={toggleHostDetails}
                  onClose={closeHostDetails}
                >
                  <Suspense fallback={null}>
                    <HostDetails />
                  </Suspense>
                </SlideOver>
                <SlideOver
                  label="Forward details"
                  open={forwardDetailsShown && !settingsOpen}
                  width={slideOverWidth}
                  onWidthChange={setSlideOverWidth}
                  onToggle={closeForwardDetails}
                  onClose={closeForwardDetails}
                >
                  <Suspense fallback={null}>
                    <ForwardDetails />
                  </Suspense>
                </SlideOver>
                <SlideOver
                  label="Environment details"
                  open={environmentDetailsShown && !settingsOpen}
                  width={slideOverWidth}
                  onWidthChange={setSlideOverWidth}
                  onToggle={toggleEnvironmentDetails}
                  onClose={closeEnvironmentDetails}
                >
                  <EnvironmentDetailsPanel />
                </SlideOver>
                <SlideOver
                  label="Snippet"
                  open={snippetEditorShown && !settingsOpen}
                  width={slideOverWidth}
                  onWidthChange={setSlideOverWidth}
                  onToggle={closeSnippetEditor}
                  onClose={closeSnippetEditor}
                >
                  <Suspense fallback={null}>
                    <SnippetEditor />
                  </Suspense>
                </SlideOver>
              </div>

              <RightRail platform={platform} />
            </div>
          )}
        </div>

        <StatusBar />
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} context={context} mode={paletteMode} />
      <ImportDialog
        open={importDialogOpen}
        onOpenChange={(next) => (next ? useUiStore.getState().openImportDialog() : closeImportDialog())}
      />
      <ImportCurlFromTarget />
      <FolderAuthDialog />
      <FolderScriptsDialog />
      <NewProjectDialog />
      <CreateWorkspaceDialog />
      <WorkspaceManageDialog />
      <RemoveProjectDialog />
      <RevealSecretsDialog />
      <UnsavedCloseDialog />
      <ShareDialog />
      <JoinDialog />
      <OpenTeamWorkspaceDialog />
      <SignInDialog />
      <TeamDialog />
      <WebhooksDialogs />
      <SchedulesDialogs />
      <WebhookSettingsDialog />
      <ImportWebhooksDialog />
      <SaveAsWebhookDialog />
      <MoveProjectDialog />
      <SyncPanel />
      <ConflictResolver />
      {/* Here, not in an editor: a run or a catalogue refresh from anywhere may need an answer. */}
      <McpApprovalDialog />
      <IdentityDialog />
      <SecretReviewDialog />
      <SecretTokenDialog />
      <SecretSourcesDialog />
      <SecretSourcesApproveDialog />
      {/* Here, not in the Hosts view: a connect from a terminal tab prompts while that view is hidden.
          Each in its own boundary, so one loading never hides another that is open. */}
      {sshEnabled && trustAsked && (
        <Suspense fallback={null}>
          <TrustDialog />
        </Suspense>
      )}
      {sshEnabled && hostDeleteAsked && (
        <Suspense fallback={null}>
          <HostDeleteDialog />
        </Suspense>
      )}
      {sshEnabled && forwardAsked && (
        <Suspense fallback={null}>
          <ForwardPrompts />
        </Suspense>
      )}
      {sshEnabled && snippetRunAsked && (
        <Suspense fallback={null}>
          <SnippetRunDialog />
        </Suspense>
      )}
      {sshEnabled && sessionLogsOpen && (
        <Suspense fallback={null}>
          <SessionLogsDialog />
        </Suspense>
      )}
      {sshEnabled && teamSessionLogsOpen && (
        <Suspense fallback={null}>
          <TeamSessionLogsDialog />
        </Suspense>
      )}
      {sshEnabled && joinShareOpen && (
        <Suspense fallback={null}>
          <JoinShareDialog />
        </Suspense>
      )}
      <CollectionExportReportDialog />
      <ToastViewport />
    </TooltipPrimitive.Provider>
  );
}
