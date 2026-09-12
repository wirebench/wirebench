import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { App } from '../../src/renderer/app.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

/** The IDE only renders with a workspace open; `null` shows the picker instead. */
function stubWirebench(workspace: WorkspaceWire | null = workspaceWire()): void {
  installWirebenchApi({
    workspace: {
      snapshot: vi.fn().mockResolvedValue({ ok: true, value: { workspace } }),
    },
    app: {
      version: vi.fn().mockResolvedValue({
        ok: true,
        value: { version: '0.1.0', electron: '44.0.0', node: '24.0.0' },
      }),
    },
    project: {
      snapshot: vi.fn().mockResolvedValue({ ok: true, value: { project: null } }),
    },
  });
}

/** The shell reads the platform from the user agent; pin it to macOS so ⌘ bindings apply. */
function stubMacUserAgent(): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
}

function stubMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      media: '',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }),
  });
}

describe('AppShell', () => {
  beforeEach(() => {
    stubWirebench();
    stubMacUserAgent();
    stubMatchMedia();
    localStorage.clear();
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useUiStore.getState().persistTo(undefined);
    // Seeded as well as stubbed, so the very first render is already the IDE rather than a
    // picker that flips over once the snapshot lands.
    useWorkspaceStore.setState({ workspace: workspaceWire() });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders every shell region', () => {
    render(<App />);

    for (const region of [
      'title-bar',
      'activity-bar',
      'sidebar',
      'editor-area',
      'console',
      'details-panel',
      'status-bar',
    ]) {
      expect(screen.getByTestId(region)).toBeTruthy();
    }
  });

  it('shows the empty editor placeholder when no tab is open', () => {
    render(<App />);

    expect(screen.getByRole('tab', { name: 'Start' })).toBeTruthy();
    expect(screen.getByTestId('editor-empty')).toBeTruthy();
  });

  it('shows neither the picker nor the IDE until the first snapshot answers', async () => {
    let answer: (value: unknown) => void = () => undefined;
    installWirebenchApi({
      workspace: {
        snapshot: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            answer = resolve;
          }),
        ),
      },
    });
    useWorkspaceStore.setState({ workspace: null, ready: false });
    render(<App />);

    expect(screen.getByTestId('workspace-loading')).toBeTruthy();
    expect(screen.queryByTestId('workspace-picker')).toBeNull();
    expect(screen.queryByTestId('editor-area')).toBeNull();

    await act(async () => {
      answer({ ok: true, value: { workspace: workspaceWire() } });
      await Promise.resolve();
    });
    expect(await screen.findByTestId('editor-area')).toBeTruthy();
    expect(screen.queryByTestId('workspace-picker')).toBeNull();
  });

  it('shows the workspace picker, under the title bar, when no workspace is open', async () => {
    stubWirebench(null);
    useWorkspaceStore.setState({ workspace: null, ready: false });
    render(<App />);

    expect(await screen.findByTestId('workspace-picker')).toBeTruthy();
    expect(screen.getByTestId('title-bar')).toBeTruthy();
    expect(screen.getByTestId('workspace-create-name')).toBeTruthy();
    expect(screen.getByTestId('workspace-create')).toBeTruthy();
    // None of the IDE chrome is there to act on a workspace that does not exist.
    expect(screen.queryByTestId('editor-area')).toBeNull();
    expect(screen.queryByTestId('sidebar')).toBeNull();
  });

  it('hides the sidebar on Mod+B and shows it again', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByTestId('sidebar')).toBeTruthy();

    await user.keyboard('{Meta>}b{/Meta}');

    expect(screen.queryByTestId('sidebar')).toBeNull();

    await user.keyboard('{Meta>}b{/Meta}');

    expect(screen.getByTestId('sidebar')).toBeTruthy();
  });

  it('hides the console on Mod+J', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard('{Meta>}j{/Meta}');

    expect(screen.queryByTestId('console')).toBeNull();
  });

  it('opens the command palette on Mod+K and lists commands with their shortcuts', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.keyboard('{Meta>}k{/Meta}');

    const palette = await screen.findByRole('dialog', { name: 'Command palette' });

    expect(palette).toBeTruthy();
    expect(screen.getByText('Toggle Sidebar')).toBeTruthy();
    expect(screen.getByText('⌘B')).toBeTruthy();
  });

  it('collapses the sidebar when the active activity-bar view is clicked again', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Explorer' }));

    expect(screen.queryByTestId('sidebar')).toBeNull();
  });

  it('shows the app version from IPC in the status bar', async () => {
    render(<App />);

    expect(await screen.findByText('v0.1.0')).toBeTruthy();
  });
});
