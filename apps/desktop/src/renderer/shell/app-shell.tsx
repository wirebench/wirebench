import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PanelSize } from 'react-resizable-panels';
import { Group, Panel, Separator } from 'react-resizable-panels';
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
import { CommandPalette } from './command-palette.js';
import type { PaletteMode } from './command-palette.js';
import { ConsolePanel } from './console-panel.js';
import { DetailsPanel } from './details-panel.js';
import { EditorArea } from './editor-area.js';
import { ImportDialog } from '../features/explorer/import-dialog.js';
import { Sidebar } from './sidebar.js';
import { StatusBar } from './status-bar.js';
import { TitleBar } from './title-bar.js';

const SEPARATOR_VERTICAL = 'w-px bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';
const SEPARATOR_HORIZONTAL = 'h-px bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/** Panel sizes are stored as percentages, so only that half of the reported size is kept. */
function asPercentage(setSize: (size: number) => void) {
  return (size: PanelSize) => {
    setSize(size.asPercentage);
  };
}

/**
 * The IDE shell: title bar, activity bar, sidebar, editor area, console, details, status bar.
 * Owns the palette's open state and the one keydown listener; every region below is presentational.
 */
export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>('commands');
  const platform = useMemo(() => detectPlatform(), []);

  const sidebar = useUiStore((state) => state.sidebar);
  const consoleState = useUiStore((state) => state.console);
  const details = useUiStore((state) => state.details);
  const theme = useUiStore((state) => state.theme);
  const editorLineNumbers = useUiStore((state) => state.editorLineNumbers);
  const editorLayout = useUiStore((state) => state.editorLayout);
  const selection = useUiStore((state) => state.selection);
  const setSidebarSize = useUiStore((state) => state.setSidebarSize);
  const setConsoleSize = useUiStore((state) => state.setConsoleSize);
  const setDetailsSize = useUiStore((state) => state.setDetailsSize);
  const importDialogOpen = useUiStore((state) => state.importDialogOpen);
  const closeImportDialog = useUiStore((state) => state.closeImportDialog);

  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaceReady = useWorkspaceStore((state) => state.ready);
  // The title bar's dot means "something is unsaved": any open project will do.
  const dirty = useProjectStore((state) => Object.values(state.projects).some((project) => project.dirty));

  useEffect(() => {
    hydrateUi();
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
      ui: { sidebar, console: consoleState, details, theme, editorLineNumbers, editorLayout },
      selection,
    }),
    [platform, sidebar, consoleState, details, theme, editorLineNumbers, editorLayout, selection],
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
          <div className="flex min-h-0 flex-1">
            <ActivityBar platform={platform} />

            <Group
              // Panels are added and removed as regions are toggled; keying the group on which
              // are mounted lets it recompute its constraints instead of reconciling across shapes.
              key={`${String(sidebar.visible)}-${String(details.visible)}`}
              orientation="horizontal"
              className="flex min-w-0 flex-1"
            >
              {sidebar.visible && (
                <>
                  <Panel
                    id="sidebar-panel"
                    defaultSize={`${String(sidebar.size)}%`}
                    minSize="12%"
                    maxSize="40%"
                    onResize={asPercentage(setSidebarSize)}
                    className="border-r border-hairline"
                  >
                    <Sidebar />
                  </Panel>
                  <Separator aria-label="Resize" className={SEPARATOR_VERTICAL} />
                </>
              )}

              <Panel id="main-panel" minSize="30%">
                <Group key={String(consoleState.visible)} orientation="vertical" className="flex h-full flex-col">
                  <Panel id="editors-panel" minSize="20%">
                    <EditorArea />
                  </Panel>
                  {consoleState.visible && (
                    <>
                      <Separator aria-label="Resize" className={SEPARATOR_HORIZONTAL} />
                      <Panel
                        id="console-panel"
                        defaultSize={`${String(consoleState.size)}%`}
                        minSize="10%"
                        maxSize="70%"
                        onResize={asPercentage(setConsoleSize)}
                      >
                        <ConsolePanel />
                      </Panel>
                    </>
                  )}
                </Group>
              </Panel>

              {details.visible && (
                <>
                  <Separator aria-label="Resize" className={SEPARATOR_VERTICAL} />
                  <Panel
                    id="details-pane"
                    defaultSize={`${String(details.size)}%`}
                    minSize="12%"
                    maxSize="40%"
                    onResize={asPercentage(setDetailsSize)}
                  >
                    <DetailsPanel />
                  </Panel>
                </>
              )}
            </Group>
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
