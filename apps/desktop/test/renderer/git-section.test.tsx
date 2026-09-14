import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { GitSection } from '../../src/renderer/features/preferences/sections/git-section.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { PreferencesPatchWire, PreferencesWire } from '../../src/shared/wire-types.js';

function renderSection(
  preferences: PreferencesWire = DEFAULT_PREFERENCES_WIRE,
  update: (patch: PreferencesPatchWire) => void = vi.fn(),
) {
  render(<GitSection preferences={preferences} update={update} />);
}

describe('GitSection', () => {
  afterEach(() => {
    cleanup();
  });

  it('detects git on mount and shows the version', async () => {
    const detect = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { location: { path: '/usr/bin/git', version: '2.40.0' } } });
    installWirebenchApi({ git: { detect } });

    renderSection();

    await waitFor(() => {
      expect(detect).toHaveBeenCalledWith({});
      expect(screen.getByTestId('git-version').textContent).toContain('2.40.0');
    });
  });

  it('shows the not-found text when detect returns null', async () => {
    const detect = vi.fn().mockResolvedValue({ ok: true, value: { location: null } });
    installWirebenchApi({ git: { detect } });

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId('git-version').textContent).toContain('install git to sync workspaces');
    });
  });

  it('calls git.locate and re-detects on Locate…', async () => {
    const detect = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: { location: null } })
      .mockResolvedValueOnce({ ok: true, value: { location: { path: '/opt/git', version: '2.44.0' } } });
    const locate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        location: { path: '/opt/git', version: '2.44.0' },
        preferences: { ...DEFAULT_PREFERENCES_WIRE, git: { path: '/opt/git', pathPickedByMain: true } },
      },
    });
    installWirebenchApi({ git: { detect, locate } });

    renderSection();
    await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));

    screen.getByTestId('git-locate').click();

    await waitFor(() => {
      expect(locate).toHaveBeenCalledWith({});
      expect(detect).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('git-version').textContent).toContain('2.44.0');
    });
  });

  it('calls git.clearPath on Clear, and hides Clear when no path is set', async () => {
    const detect = vi.fn().mockResolvedValue({ ok: true, value: { location: null } });
    const clearPath = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    installWirebenchApi({ git: { detect, clearPath } });

    const preferences: PreferencesWire = {
      ...DEFAULT_PREFERENCES_WIRE,
      git: { path: '/opt/git', pathPickedByMain: true },
    };
    renderSection(preferences);

    await waitFor(() => expect(detect).toHaveBeenCalled());
    expect(screen.getByTestId('git-clear')).toBeTruthy();

    screen.getByTestId('git-clear').click();

    await waitFor(() => {
      expect(clearPath).toHaveBeenCalledWith({});
      expect(detect).toHaveBeenCalledTimes(2);
    });
  });

  it('hides Clear when preferences.git.path is empty', () => {
    installWirebenchApi({
      git: { detect: vi.fn().mockResolvedValue({ ok: true, value: { location: null } }) },
    });
    renderSection();
    expect(screen.queryByTestId('git-clear')).toBeNull();
  });

  it('shows an inline error when Locate… fails, with no toast', async () => {
    const detect = vi.fn().mockResolvedValue({ ok: true, value: { location: null } });
    const locate = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'git-not-found', message: '"/not/git" is not a usable git executable.' },
    });
    installWirebenchApi({ git: { detect, locate } });

    renderSection();
    await waitFor(() => expect(detect).toHaveBeenCalled());

    screen.getByTestId('git-locate').click();

    await waitFor(() => {
      expect(screen.getByTestId('git-error').textContent).toContain('is not a usable git executable');
    });
  });

  it('never calls preferences.update with git keys', async () => {
    const update = vi.fn();
    const detect = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { location: { path: '/usr/bin/git', version: '2.40.0' } } });
    const locate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        location: { path: '/opt/git', version: '2.44.0' },
        preferences: { ...DEFAULT_PREFERENCES_WIRE, git: { path: '/opt/git', pathPickedByMain: true } },
      },
    });
    const clearPath = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    installWirebenchApi({ git: { detect, locate, clearPath } });

    renderSection(DEFAULT_PREFERENCES_WIRE, update);
    await waitFor(() => expect(detect).toHaveBeenCalled());

    screen.getByTestId('git-locate').click();
    await waitFor(() => expect(locate).toHaveBeenCalled());

    expect(update).not.toHaveBeenCalled();
  });
});
