import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthFields } from '../../src/renderer/components/auth-fields.js';
import { resetKerberosAvailability } from '../../src/renderer/lib/use-kerberos-availability.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

beforeEach(() => {
  resetKerberosAvailability();
});

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

  it('starts a switch to Kerberos clean, keeping only spn and principal', () => {
    availability({ available: true, platform: 'linux' });
    const onChange = vi.fn();
    render(
      <AuthFields
        scope="API"
        auth={{ type: 'basic', username: 'ada', passwordRef: 'ref-p', preemptive: false }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('API authentication type'), { target: { value: 'kerberos' } });
    expect(onChange).toHaveBeenCalledWith({ type: 'kerberos' });
  });

  it('off Windows, shows an inherited Windows account and offers to clear it, keeping spn and principal', async () => {
    availability({ available: true, platform: 'darwin' });
    const onChange = vi.fn();
    render(
      <AuthFields
        scope="API"
        auth={{
          type: 'kerberos',
          spn: 'HTTP/svc',
          principal: 'ada@EXAMPLE.TEST',
          username: 'ada',
          domain: 'CORP',
          passwordRef: 'ref-p',
        }}
        onChange={onChange}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText('This configuration names a Windows account, which macOS and Linux refuse.'),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear account' }));
    expect(onChange).toHaveBeenCalledWith({ type: 'kerberos', spn: 'HTTP/svc', principal: 'ada@EXAMPLE.TEST' });
  });

  it('shows no account note off Windows when no account is named, nor on Windows when one is', async () => {
    availability({ available: true, platform: 'linux' });
    const { unmount } = render(
      <AuthFields scope="API" auth={{ type: 'kerberos', spn: 'HTTP/svc' }} onChange={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByLabelText('API principal')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Clear account' })).toBeNull();
    unmount();

    resetKerberosAvailability();
    availability({ available: true, platform: 'win32' });
    render(<AuthFields scope="API" auth={{ type: 'kerberos', username: 'ada' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Use another account')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Clear account' })).toBeNull();
  });

  it('settles to unavailable, with a reason, when the IPC call rejects', async () => {
    installWirebenchApi({ auth: { kerberosAvailability: vi.fn().mockRejectedValue(new Error('boom')) } });
    render(<AuthFields scope="API" auth={{ type: 'kerberos' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Kerberos availability could not be checked.')).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Kerberos' })).toHaveProperty('disabled', true);
  });
});
