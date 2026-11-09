import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DevicesPage } from '../../src/renderer/features/preferences/user/devices-page.js';
import { useUserSettingsStore } from '../../src/renderer/state/user-settings.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const DEVICES = [
  {
    id: 't1',
    name: 'Chrome on macOS',
    current: true,
    createdAt: '2026-11-09T10:00:00.000Z',
    lastUsedAt: '2026-11-09T11:00:00.000Z',
  },
  {
    id: 't2',
    name: 'Firefox on Linux',
    current: false,
    createdAt: '2026-11-08T10:00:00.000Z',
    lastUsedAt: '2026-11-08T11:00:00.000Z',
  },
];

describe('Signed-in devices (#900)', () => {
  beforeEach(() => {
    useUserSettingsStore.setState({ devices: DEVICES });
  });
  afterEach(() => {
    cleanup();
  });

  it('marks the current row This device on the desktop', () => {
    installWirebenchApi();
    render(<DevicesPage />);
    expect(screen.getByTestId('user-device-t1').textContent).toContain('This device');
    expect(screen.getByTestId('user-device-t1').textContent).toContain('Chrome on macOS');
  });

  it('marks the current row This browser in a browser tab', () => {
    const api = installWirebenchApi();
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'] },
    });
    render(<DevicesPage />);
    expect(screen.getByTestId('user-device-t1').textContent).toContain('This browser');
    expect(screen.getByTestId('user-device-t2').textContent).toContain('Firefox on Linux');
  });
});
