/** The WSDL import dialog's *Kerberos (signed-in ticket)* choice: it sends only an optional SPN, and follows Task 14's gating. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { resetKerberosAvailability } from '../../src/renderer/lib/use-kerberos-availability.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

const project: ProjectWire = {
  ...NO_REST,
  settings: PROJECT_SETTINGS,
  id: 'proj-1',
  name: 'Demo',
  dir: '/tmp/demo',
  dirty: false,
  interfaces: [],
  requests: [],
  properties: {},
  disabledProperties: [],
  environments: [],
  problems: [],
  keystores: [],
  wssOutgoing: [],
  wssIncoming: [],
};

function stub(availability: { available: boolean; reason?: string; platform: 'win32' | 'darwin' | 'linux' }): {
  addInterface: ReturnType<typeof vi.fn>;
} {
  const addInterface = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { projectId: project.id, project, interfaceId: 'iface-1' } });
  installWirebenchApi({
    project: { addInterface },
    auth: { kerberosAvailability: vi.fn().mockResolvedValue({ ok: true, value: availability }) },
    definition: { cancelImport: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }) },
  });
  return { addInterface };
}

describe('the import dialog with Kerberos', () => {
  beforeEach(() => {
    resetKerberosAvailability();
    useProjectStore.getState().reset();
    useProjectStore.getState().applySnapshot(project.id, project);
  });
  afterEach(cleanup);

  it('sends the SPN as the definition authentication', async () => {
    const { addInterface } = stub({ available: true, platform: 'linux' });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Kerberos (signed-in ticket)' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Definition authentication'), { target: { value: 'kerberos' } });
    fireEvent.change(screen.getByLabelText('Definition SPN'), { target: { value: 'HTTP/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(addInterface).toHaveBeenCalled());
    expect((addInterface.mock.calls[0]?.[0] as { auth: unknown }).auth).toEqual({ type: 'kerberos', spn: 'HTTP/x' });
  });

  it('sends no SPN when the field is left empty', async () => {
    const { addInterface } = stub({ available: true, platform: 'win32' });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Kerberos (signed-in ticket)' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Definition authentication'), { target: { value: 'kerberos' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(addInterface).toHaveBeenCalled());
    expect((addInterface.mock.calls[0]?.[0] as { auth: unknown }).auth).toEqual({ type: 'kerberos' });
  });

  it('offers Kerberos disabled, with the reason, where it is unavailable', async () => {
    stub({ available: false, reason: 'No Kerberos library here.', platform: 'linux' });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Kerberos (signed-in ticket)' }).hasAttribute('disabled')).toBe(true),
    );
    expect(screen.getByText('No Kerberos library here.')).toBeTruthy();
  });

  it('keeps Basic working through the same select', () => {
    stub({ available: true, platform: 'linux' });
    render(<ImportDialog open onOpenChange={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('WSDL URL'), { target: { value: 'http://example.test/service.wsdl' } });
    fireEvent.change(screen.getByLabelText('Definition authentication'), { target: { value: 'basic' } });
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.queryByLabelText('Definition SPN')).toBeNull();
  });
});
