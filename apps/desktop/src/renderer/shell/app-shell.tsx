import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Loader2 } from 'lucide-react';
import { ToastViewport } from '../components/toast.js';
import { registerShellCommands } from '../commands/register-shell-commands.js';
import type { CommandContext } from '../lib/commands.js';
import { runCommand } from '../lib/commands.js';
import { useKeybindings } from '../lib/keybindings.js';
import { detectPlatform } from '../lib/platform.js';
import { useTheme } from '../lib/theme.js';
import { hydrateUi, useUiStore } from '../state/ui.js';
import { rememberOpenWorkspaceTabs } from '../state/workspace-tabs.js';
import { subscribeToGlobals } from '../state/globals.js';
import { subscribeToPreferences, usePreferencesStore } from '../state/preferences.js';
import { subscribeToHistory } from '../state/history.js';
import { subscribeToProject, useProjectStore } from '../state/project.js';
import { subscribeToWorkspace, useWorkspaceStore } from '../state/workspace.js';
import { WorkspacePicker } from '../features/workspace/picker-screen.js';
import { NewProjectDialog } from '../features/workspace/new-project-dialog.js';
import { CreateWorkspaceDialog } from '../features/workspace/create-workspace-dialog.js';
import { WorkspaceManageDialog } from '../features/workspace/manage-dialog.js';
import { RemoveProjectDialog } from '../features/workspace/remove-project-dialog.js';
import { ActivityBar } from './activity-bar.js';
import { subscribeToMenuCommands, syncAppMenu } from './app-menu.js';
import { CodePanel } from './code-panel.js';
import { CommandPalette } from './command-palette.js';
import type { PaletteMode } from './command-palette.js';
import { ConsolePanel } from './console-panel.js';
import { EditorArea } from './editor-area.js';
import { ImportDialog } from '../features/explorer/import-dialog.js';
import { PanelHandle } from './panel-handle.js';
import { RightRail } from './right-rail.js';
import { Sidebar } from './sidebar.js';
import { SlideOver } from './slide-over.js';
import { StatusBar } from './status-bar.js';
import { TitleBar } from './title-bar.js';

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
export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const platform = useMemo(() => detectPlatform(), []);

  const sidebar = useUiStore((state) => state.sidebar);
  const consoleState = useUiStore((state) => state.console);
  const slideOver = useUiStore((state) => state.slideOver);
  const theme = useUiStore((state) => state.theme);
  const editorLineNumbers = useUiStore((state) => state.editorLineNumbers);
  const editorLayout = useUiStore((state) => state.editorLayout);
  const selection = useUiStore((state) => state.selection);
  const setSlideOverWidth = useUiStore((state) => state.setSlideOverWidth);
  const toggleCode = useUiStore((state) => state.toggleCode);
  const closeCode = useUiStore((state) => state.closeCode);
  const importDialogOpen = useUiStore((state) => state.importDialogOpen);
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
  const dirty = useProjectStore((state) => Object.values(state.projects).some((project) => project.dirty));

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
  useEffect(() => subscribeToProject(), []);
  useEffect(() => subscribeToGlobals(), []);
  useEffect(() => subscribeToPreferences(), []);
  useEffect(() => subscribeToHistory(), []);

  const openPalette = useCallback((mode: PaletteMode = 'commands') => {
    setPaletteMode(mode);
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    registerShellCommands(openPalette);
    // The manifest is built from the registry, so it can only be sent once registration ran.
    void syncAppMenu();
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
                    is collapsed. */}
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
                {consoleState.visible && (
                  <div
                    data-testid="console-panel"
                    style={{ height: `${String(consoleState.size)}%` }}
                    className="min-h-0 shrink-0"
                  >
                    <ConsolePanel />
                  </div>
                )}
              </div>
            </div>

            <RightRail platform={platform} />
            {/* The slide-over is the exception to the two handles above: it overlays the editor
                rather than sharing the row with it, so while closed it unmounts completely — a
                handle left over the editor's right edge would swallow clicks and drag-selection
                there. The rail's Code icon and `view.toggleCode` reopen it. */}
            <SlideOver
              label="Code"
              open={slideOver.open}
              width={slideOver.width}
              onWidthChange={setSlideOverWidth}
              onToggle={toggleCode}
              onClose={closeCode}
            >
              <CodePanel />
            </SlideOver>
          </div>
        )}

        <StatusBar />
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} context={context} mode={paletteMode} />
      <ImportDialog
        open={importDialogOpen}
        onOpenChange={(next) => (next ? useUiStore.getState().openImportDialog() : closeImportDialog())}
      />
      <NewProjectDialog />
      <CreateWorkspaceDialog />
      <WorkspaceManageDialog />
      <RemoveProjectDialog />
      <ToastViewport />
    </TooltipPrimitive.Provider>
  );
}
