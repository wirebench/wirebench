import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TeamSecretsSection } from '../../src/renderer/features/sync/team-secrets-section.js';
import { TEAM_SECRETS_OFF_STATUS, useTeamSecretsStore } from '../../src/renderer/state/team-secrets.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { TeamSecretsKeyWire, TeamSecretsStatusWire } from '../../src/shared/wire-types.js';

const ADA: TeamSecretsKeyWire = {
  keyId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
  name: 'Ada',
  email: 'ada@example.test',
  machine: 'ada-laptop',
  fingerprint: '1a2b 3c4d 5e6f 7a8b',
  requestedAt: '2026-09-26T10:00:00.000Z',
  admin: true,
  mine: true,
};
const BEN: TeamSecretsKeyWire = {
  ...ADA,
  keyId: 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
  name: 'Ben',
  email: 'ben@example.test',
  machine: 'ben-desktop',
  fingerprint: '9f8e 7d6c 5b4a 3928',
  admin: false,
  mine: false,
};

function status(patch: Partial<TeamSecretsStatusWire>): TeamSecretsStatusWire {
  return {
    ...TEAM_SECRETS_OFF_STATUS,
    on: true,
    authority: 'signed',
    canManage: true,
    me: { state: 'approved', keyId: ADA.keyId, fingerprint: ADA.fingerprint, admin: true },
    approved: [ADA],
    ...patch,
  };
}

describe('TeamSecretsSection', () => {
  afterEach(() => {
    cleanup();
    useTeamSecretsStore.getState().reset();
  });

  it('offers to turn team secrets on when it may', async () => {
    const turnOn = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { turnOn } });
    useTeamSecretsStore.setState({ status: { ...TEAM_SECRETS_OFF_STATUS, canTurnOn: true } });
    render(<TeamSecretsSection />);
    await userEvent.click(screen.getByTestId('team-secrets-turn-on'));
    expect(turnOn).toHaveBeenCalled();
  });

  it('shows a request with its fingerprint, the out-of-band check, and approves it', async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true, value: status({ approved: [ADA, BEN] }) });
    installWirebenchApi({ teamSecrets: { approve } });
    useTeamSecretsStore.setState({ status: status({ pending: [BEN] }) });
    render(<TeamSecretsSection />);

    const row = screen.getByTestId('team-secrets-pending-row');
    expect(row.textContent).toContain('Ben');
    expect(row.textContent).toContain('ben-desktop');
    expect(row.textContent).toContain('9f8e 7d6c 5b4a 3928');
    expect(screen.getByTestId('team-secrets-fingerprint-note').textContent).toContain('another way');
    await userEvent.click(screen.getByTestId('team-secrets-approve'));
    expect(approve).toHaveBeenCalledWith({ keyId: BEN.keyId });
    await waitFor(() => expect(screen.queryByTestId('team-secrets-pending-row')).toBeNull());
  });

  it('warns a lone admin, and confirms a removal', async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { remove } });
    useTeamSecretsStore.setState({ status: status({ approved: [ADA, BEN] }) });
    render(<TeamSecretsSection />);

    expect(screen.getByTestId('team-secrets-single-admin')).toBeTruthy();
    await userEvent.click(screen.getAllByTestId('team-secrets-remove')[0]!);
    await userEvent.click(screen.getByTestId('team-secrets-remove-confirm'));
    expect(remove).toHaveBeenCalledWith({ keyId: BEN.keyId });
  });

  it('lists what to rotate, what it ignored, and a replaced value to restore', async () => {
    const restoreMine = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { restoreMine } });
    useTeamSecretsStore.setState({
      status: status({
        rotate: [
          { entryId: 'CCCCCCCCCCCCCCCCCCCCCCCCCC', label: 'Password', secret: { ref: 'sec_x' }, removedNames: ['Cy'] },
        ],
        untrusted: [{ entryId: 'DDDDDDDDDDDDDDDDDDDDDDDDDD', label: 'Token' }],
        replaced: [{ entryId: 'EEEEEEEEEEEEEEEEEEEEEEEEEE', label: 'Api key', byName: 'Ben' }],
      }),
    });
    render(<TeamSecretsSection />);

    expect(screen.getByTestId('team-secrets-rotate-row').textContent).toContain('Cy');
    expect(screen.getByTestId('team-secrets-untrusted-row').textContent).toContain('Token');
    expect(screen.getByTestId('team-secrets-replaced-row').textContent).toContain('Ben');
    await userEvent.click(screen.getByTestId('team-secrets-restore'));
    expect(restoreMine).toHaveBeenCalledWith({ entryId: 'EEEEEEEEEEEEEEEEEEEEEEEEEE' });
  });

  it('tells a waiting machine its fingerprint, and a removed one how to ask again', async () => {
    const requestAccess = vi.fn().mockResolvedValue({ ok: true, value: status({}) });
    installWirebenchApi({ teamSecrets: { requestAccess } });
    useTeamSecretsStore.setState({
      status: status({
        canManage: false,
        me: { state: 'pending', keyId: BEN.keyId, fingerprint: BEN.fingerprint, admin: false },
      }),
    });
    const { rerender } = render(<TeamSecretsSection />);
    expect(screen.getByTestId('team-secrets-me').textContent).toContain('Waiting for an admin');
    expect(screen.getByTestId('team-secrets-me').textContent).toContain(BEN.fingerprint);

    useTeamSecretsStore.setState({
      status: status({
        canManage: false,
        me: { state: 'removed', keyId: BEN.keyId, admin: false },
        message: 'An admin removed this machine from team secrets.',
      }),
    });
    rerender(<TeamSecretsSection />);
    await userEvent.click(screen.getByTestId('team-secrets-request-access'));
    expect(requestAccess).toHaveBeenCalled();
  });
});
