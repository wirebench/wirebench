import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangedOnDiskBanner } from '../../src/renderer/features/project/changed-on-disk-banner.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

function project(dirty: boolean): ProjectWire {
  return {
    settings: PROJECT_SETTINGS,
    id: 'p',
    name: 'Demo',
    dir: '/tmp/demo',
    dirty,
    interfaces: [],
    requests: [],
    properties: {},
    environments: [],
    problems: [],
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
  };
}

describe('ChangedOnDiskBanner', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useProjectStore.getState().applySnapshot('p', project(false));
    installWirebenchApi();
  });
  afterEach(cleanup);

  it('stays out of the way until the watcher reports something', () => {
    render(<ChangedOnDiskBanner />);
    expect(screen.queryByTestId('changed-on-disk-banner')).toBeNull();
  });

  it('reloads straight away when there is nothing unsaved', async () => {
    const reload = vi.fn().mockResolvedValue({ ok: true, value: { project: project(false) } });
    installWirebenchApi({ project: { reload } });
    useProjectStore.getState().noteChangedOnDisk('p', ['wirebench.yaml']);
    render(<ChangedOnDiskBanner />);

    await userEvent.click(screen.getByTestId('changed-on-disk-reload'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('asks first when reloading would discard unsaved edits', async () => {
    const reload = vi.fn().mockResolvedValue({ ok: true, value: { project: project(false) } });
    installWirebenchApi({ project: { reload } });
    useProjectStore.getState().applySnapshot('p', project(true));
    useProjectStore.getState().noteChangedOnDisk('p', ['wirebench.yaml']);
    render(<ChangedOnDiskBanner />);

    await userEvent.click(screen.getByTestId('changed-on-disk-reload'));
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(/discards your unsaved changes/i)).toBeTruthy();

    await userEvent.click(screen.getByTestId('changed-on-disk-reload'));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('Ignore dismisses the banner without reloading', async () => {
    const reload = vi.fn();
    installWirebenchApi({ project: { reload } });
    useProjectStore.getState().noteChangedOnDisk('p', ['wirebench.yaml']);
    render(<ChangedOnDiskBanner />);

    await userEvent.click(screen.getByTestId('changed-on-disk-ignore'));
    expect(screen.queryByTestId('changed-on-disk-banner')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows one banner per project with changes, each naming its project', () => {
    useProjectStore.getState().applySnapshot('p2', { ...project(false), id: 'p2', name: 'Geo' });
    useProjectStore.getState().noteChangedOnDisk('p', ['wirebench.yaml']);
    useProjectStore.getState().noteChangedOnDisk('p2', ['a.yaml', 'b.yaml']);
    render(<ChangedOnDiskBanner />);

    const banners = screen.getAllByRole('status');
    expect(banners).toHaveLength(2);
    expect(banners.map((banner) => banner.getAttribute('data-project-id'))).toEqual(['p', 'p2']);
    expect(banners[0]?.textContent).toContain('Demo: 1 file changed on disk');
    expect(banners[1]?.textContent).toContain('Geo: 2 files changed on disk');
    // The first banner keeps the stable ids the e2e spec drives.
    expect(screen.getByTestId('changed-on-disk-banner')).toBe(banners[0]);
  });

  it('reloads only the project whose banner was used', async () => {
    const reload = vi.fn().mockResolvedValue({ ok: true, value: { project: project(false) } });
    installWirebenchApi({ project: { reload } });
    useProjectStore.getState().applySnapshot('p2', { ...project(false), id: 'p2', name: 'Geo' });
    useProjectStore.getState().noteChangedOnDisk('p', ['wirebench.yaml']);
    useProjectStore.getState().noteChangedOnDisk('p2', ['a.yaml']);
    render(<ChangedOnDiskBanner />);

    await userEvent.click(screen.getByTestId('changed-on-disk-reload-p2'));
    await waitFor(() => {
      expect(reload).toHaveBeenCalledWith({ projectId: 'p2' });
    });
  });
});
