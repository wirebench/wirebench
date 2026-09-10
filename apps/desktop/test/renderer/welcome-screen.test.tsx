import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WelcomeScreen } from '../../src/renderer/features/welcome/welcome-screen.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const RECENT = [
  { dir: '/tmp/payments', name: 'Payments', lastOpenedAt: '2026-09-10T08:00:00.000Z', exists: true },
  { dir: '/mnt/detached/old', name: 'Old', lastOpenedAt: '2026-01-01T08:00:00.000Z', exists: false },
];

function resetStores(): void {
  useProjectStore.setState({ project: null, interfaces: {}, requests: {}, order: [], changedOnDisk: [] });
  useUiStore.setState({ newProjectDir: undefined });
}

describe('WelcomeScreen', () => {
  beforeEach(resetStores);
  afterEach(cleanup);

  it('lists recent projects, disabling the ones whose folder is gone', async () => {
    installWirebenchApi({ project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: RECENT } }) } });
    render(<WelcomeScreen onImportDefinition={vi.fn()} />);

    const rows = await screen.findAllByTestId('recent-project');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Payments');
    expect(rows[0]?.hasAttribute('disabled')).toBe(false);
    expect(rows[1]?.hasAttribute('disabled')).toBe(true);
  });

  it('says so when there are no recent projects', async () => {
    installWirebenchApi({ project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: [] } }) } });
    render(<WelcomeScreen onImportDefinition={vi.fn()} />);

    expect(await screen.findByText('No projects yet.')).toBeTruthy();
  });

  it('opens the project a recent row names', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true, value: { project: null } });
    installWirebenchApi({
      project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: RECENT } }), open },
    });
    render(<WelcomeScreen onImportDefinition={vi.fn()} />);

    await userEvent.click((await screen.findAllByTestId('recent-project'))[0]!);
    await waitFor(() => expect(open).toHaveBeenCalledWith({ dir: '/tmp/payments' }));
  });

  it('New project picks a folder and then asks for a name', async () => {
    const openFolder = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/new-project' } });
    installWirebenchApi({
      project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: [] } }) },
      dialogs: { openFolder },
    });
    render(<WelcomeScreen onImportDefinition={vi.fn()} />);

    await userEvent.click(screen.getByTestId('welcome-new-project'));

    await waitFor(() => expect(openFolder).toHaveBeenCalled());
    // The name prompt is a separate dialog rendered by the shell; this is the handoff to it.
    await waitFor(() => expect(useUiStore.getState().newProjectDir).toBe('/tmp/new-project'));
  });

  it('New project does nothing when the folder picker is cancelled', async () => {
    const openFolder = vi.fn().mockResolvedValue({ ok: true, value: { path: undefined } });
    installWirebenchApi({
      project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: [] } }) },
      dialogs: { openFolder },
    });
    render(<WelcomeScreen onImportDefinition={vi.fn()} />);

    await userEvent.click(screen.getByTestId('welcome-new-project'));
    await waitFor(() => expect(openFolder).toHaveBeenCalled());
    expect(useUiStore.getState().newProjectDir).toBeUndefined();
  });

  it('Open project opens the folder that was picked', async () => {
    const openFolder = vi.fn().mockResolvedValue({ ok: true, value: { path: '/tmp/existing' } });
    const open = vi.fn().mockResolvedValue({ ok: true, value: { project: null } });
    installWirebenchApi({
      project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: [] } }), open },
      dialogs: { openFolder },
    });
    render(<WelcomeScreen onImportDefinition={vi.fn()} />);

    await userEvent.click(screen.getByTestId('welcome-open-project'));
    await waitFor(() => expect(open).toHaveBeenCalledWith({ dir: '/tmp/existing' }));
  });

  it('Import WSDL hands off to the shell-owned dialog', async () => {
    const onImportDefinition = vi.fn();
    installWirebenchApi({ project: { recent: vi.fn().mockResolvedValue({ ok: true, value: { recent: [] } }) } });
    render(<WelcomeScreen onImportDefinition={onImportDefinition} />);

    await userEvent.click(screen.getByTestId('welcome-import'));
    expect(onImportDefinition).toHaveBeenCalledOnce();
  });
});
