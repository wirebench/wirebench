import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AuthFields } from '../../src/renderer/components/auth-fields.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

afterEach(() => {
  cleanup();
});

const availability = (value: { available: boolean; reason?: string; platform: 'win32' | 'darwin' | 'linux' }) =>
  installWirebenchApi({ auth: { kerberosAvailability: vi.fn().mockResolvedValue({ ok: true, value }) } });

describe('Kerberos in AuthFields', () => {
  it('offers Kerberos, with SPN and, off Windows, principal', async () => {
    availability({ available: true, platform: 'linux' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Kerberos' })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('API principal')).toBeTruthy());
    expect(screen.getByLabelText('API spn')).toHaveProperty('placeholder', 'HTTP/<host of the request>');
    expect(screen.queryByText('Use another account')).toBeNull();
  });

  it('offers another account on Windows, and no principal', async () => {
    availability({ available: true, platform: 'win32' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Use another account')).toBeTruthy());
    expect(screen.queryByLabelText('API principal')).toBeNull();
  });

  it('disables the option and says why when the binding is unavailable', async () => {
    availability({ available: false, reason: 'Kerberos is not available on Windows on ARM.', platform: 'win32' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Kerberos' })).toHaveProperty('disabled', true));
    expect(screen.getByText('Kerberos is not available on Windows on ARM.')).toBeTruthy();
  });
});
