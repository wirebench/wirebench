import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { App } from '../../src/renderer/app.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

function stubWirebench(): void {
  installWirebenchApi({
    app: {
      version: vi.fn().mockResolvedValue({
        ok: true,
        value: { version: '0.1.0', electron: '44.0.0', node: '24.0.0' },
      }),
    },
    project: {
      snapshot: vi.fn().mockResolvedValue({ ok: true, value: { project: null } }),
      recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: [] } }),
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

  it('offers the three ways into the app on the Welcome tab', () => {
    render(<App />);

    expect(screen.getByRole('tab', { name: 'Welcome' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import WSDL' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open project…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New project…' })).toBeTruthy();
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
