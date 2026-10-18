import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretsSection } from '../../src/renderer/features/preferences/sections/secrets-section.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';

const status = vi.fn();
const set = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ appLock: { status, set } }) }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('Settings → Secrets → App lock (#428)', () => {
  it('turns the app lock on through main, which asks first', async () => {
    status.mockResolvedValue({ ok: true, value: { supported: true, active: false, locked: false } });
    set.mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    const update = vi.fn();
    render(<SecretsSection preferences={DEFAULT_PREFERENCES_WIRE} update={update} />);
    const toggle = await screen.findByTestId('secrets-app-lock');
    await vi.waitFor(() => {
      expect(toggle).toHaveProperty('disabled', false);
    });
    await userEvent.click(toggle);
    expect(set).toHaveBeenCalledWith({ enabled: true });
    // Never through preferences.update: main refuses `secrets.appLock` there.
    expect(update).not.toHaveBeenCalled();
  });

  it('says so when the prompt is not passed', async () => {
    status.mockResolvedValue({ ok: true, value: { supported: true, active: false, locked: false } });
    set.mockResolvedValue({ ok: false, error: { code: 'app-locked', message: 'The app lock was not turned on' } });
    render(<SecretsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    const toggle = await screen.findByTestId('secrets-app-lock');
    await vi.waitFor(() => {
      expect(toggle).toHaveProperty('disabled', false);
    });
    await userEvent.click(toggle);
    expect((await screen.findByTestId('secrets-app-lock-error')).textContent).toContain('was not turned on');
  });

  it('is disabled with the reason where this computer cannot ask', async () => {
    status.mockResolvedValue({
      ok: true,
      value: { supported: false, reason: 'no helper', active: false, locked: false },
    });
    render(<SecretsSection preferences={DEFAULT_PREFERENCES_WIRE} update={vi.fn()} />);
    expect((await screen.findByTestId('secrets-app-lock-unavailable')).textContent).toBe(
      'Not available here: no helper.',
    );
    expect(screen.getByTestId('secrets-app-lock')).toHaveProperty('disabled', true);
  });

  it('sets the idle minutes as an ordinary preference', async () => {
    status.mockResolvedValue({ ok: true, value: { supported: true, active: true, locked: false } });
    const update = vi.fn();
    render(<SecretsSection preferences={DEFAULT_PREFERENCES_WIRE} update={update} />);
    const input = screen.getByTestId('secrets-app-lock-idle');
    await userEvent.clear(input);
    await userEvent.type(input, '30{Enter}');
    expect(update).toHaveBeenCalledWith({ secrets: { appLockIdleMinutes: 30 } });
  });
});
